import { describe, expect, it } from "vitest"
import { DurableActionError, DurableQueue, MemoryStateStore } from "../src/index"
import type { DurableContext, DurableJob } from "../src/index"
import { TestEngine } from "./helpers/engine"

/** Minimal fake bull Queue for carrier resolution / revive tests. */
function fakeQueue() {
  const jobs = new Map<
    string,
    { id: string; state: string; promoted: number; retried: number; logs: string[] }
  >()
  const queue = {
    jobs,
    addCalls: [] as Array<{ name: string; data: unknown; opts: { jobId?: string } }>,
    seed(id: string, state: string) {
      jobs.set(id, { id, state, promoted: 0, retried: 0, logs: [] })
    },
    async getJob(id: string) {
      const record = jobs.get(id)
      if (!record) return undefined
      return {
        id,
        async getState() {
          return record.state
        },
        async promote() {
          record.promoted += 1
          record.state = "waiting"
        },
        async retry(_state?: string) {
          record.retried += 1
          record.state = "waiting"
        },
        async remove() {
          jobs.delete(id)
        },
        async log(line: string) {
          record.logs.push(line)
        },
      }
    },
    async add(name: string, data: unknown, opts: { jobId?: string }) {
      queue.addCalls.push({ name, data, opts })
      if (opts.jobId) queue.seed(opts.jobId, "waiting")
      return { id: opts.jobId }
    },
    async getJobLogs(_id: string) {
      return { logs: [] as string[], count: 0 }
    },
  }
  return queue
}

/** A DurableQueue over an injected store + fake bull (nothing dials Redis). */
function queueWith(name: string, store: MemoryStateStore, bull: ReturnType<typeof fakeQueue>) {
  return new DurableQueue(name, {
    connection: {} as never,
    stateStore: store,
    bull: bull as never,
  })
}

describe("DurableQueue run collection", () => {
  it("lists windows and counts from the per-queue index", async () => {
    const store = new MemoryStateStore()
    for (const id of ["a", "b", "c"]) {
      await store.initInstance({
        instanceId: `q:${id}`,
        queueName: "q",
        jobName: "job",
        jobId: id,
        input: {},
      })
    }
    await store.completeInstance("q:a", 1)
    await store.failInstance("q:b", new Error("boom"))

    const queue = queueWith("q", store, fakeQueue())
    expect(await store.queues()).toEqual(["q"])

    const active = await queue.listRuns({ kind: "active", window: 10 })
    expect(active.runs.map((r) => r.id)).toEqual(["q:c"])
    // Handles come with their snapshot loaded.
    expect(active.runs[0]!.snapshot?.status).toBe("running")
    expect(active.runs[0]!.jobId).toBe("c")

    const all = await queue.listRuns({ kind: "all", window: 10 })
    expect(all.runs).toHaveLength(3)
    expect(all.indexTotal).toBe(3)

    const counts = await queue.countRuns()
    expect(counts).toEqual({
      active: 1,
      completed: 1,
      failed: 1,
      compensation_failed: 0,
      cancelled: 0,
    })
  })

  it("getRun loads state; null when the job has none", async () => {
    const store = new MemoryStateStore()
    await store.initInstance({
      instanceId: "q:x",
      queueName: "q",
      jobName: "job",
      jobId: "x",
      input: {},
    })
    const queue = queueWith("q", store, fakeQueue())

    const run = await queue.getRun("x")
    expect(run?.id).toBe("q:x")
    expect(run?.snapshot?.jobName).toBe("job")
    expect(await queue.getRun("nope")).toBeNull()
  })

  it("summarizes with derived statuses", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleep("wait", "10m")
      return "done"
    })
    await engine.start("job", {}, "1")

    const queue = queueWith("test", engine.store as MemoryStateStore, fakeQueue())
    const summaries = await queue.summarizeRuns(await queue.activeRuns(), {
      stuckThresholdMs: 300_000,
    })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.view.derivedStatus).toBe("sleeping")
    expect(summaries[0]!.view.nextRunAt).toBeTypeOf("number")
  })

  it("close() leaves injected bull queue and store alone", async () => {
    const store = new MemoryStateStore()
    const bull = fakeQueue() // has no close(): closing it would throw
    const queue = queueWith("q", store, bull)
    void queue.bull // force lazy resolution of the injected instance
    await queue.close()
    // The store remains usable after close — it was injected, not owned.
    expect(await store.queues()).toEqual([])
  })
})

describe("DurableRun", () => {
  it("retry resets failed steps and revives the job; guards wrong states", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("boom", async () => {
        throw new Error("permanent")
      })
      return "done"
    })
    await engine.run("job", {}, "1")
    const id = engine.instanceId("1")
    expect((await engine.store.getInstance(id))?.status).toBe("failed")

    const bull = fakeQueue()
    bull.seed("1", "failed")
    const queue = queueWith("test", engine.store as MemoryStateStore, bull)
    const run = queue.run("1")

    await expect(run.resume()).rejects.toBeInstanceOf(DurableActionError)
    await expect(run.resume()).rejects.toMatchObject({ code: "invalid_state" })

    await run.retry()
    const after = await engine.store.getInstance(id)
    expect(after?.status).toBe("running")
    expect(after?.error).toBeUndefined()
    expect(await engine.store.getStep(id, "boom")).toBeNull() // failed step reset
    expect(bull.jobs.get("1")?.retried).toBe(1)
  })

  it("resolves legacy carriers and revives missing jobs by original id", async () => {
    const store = new MemoryStateStore()
    await store.initInstance({
      instanceId: "q:legacy",
      queueName: "q",
      jobName: "video",
      jobId: "legacy",
      input: { n: 1 },
    })
    await store.updateInstance("q:legacy", { status: "yielded", resumeSeq: 3 })

    const bull = fakeQueue()
    bull.seed("legacy:resume:3", "delayed")
    const run = queueWith("q", store, bull).run("legacy")

    expect(await run.carrier()).toEqual({ jobId: "legacy:resume:3", legacy: true })
    expect(await run.carrierState()).toBe("delayed")

    await run.resume()
    expect(bull.jobs.get("legacy:resume:3")?.promoted).toBe(1)

    // Carrier gone entirely → revived under the ORIGINAL id from stored input.
    bull.jobs.clear()
    await run.resume()
    expect(bull.addCalls).toEqual([{ name: "video", data: { n: 1 }, opts: { jobId: "legacy" } }])
    expect(await run.carrierState()).toBe("waiting")
  })

  it("cancel marks state and removes the carrier job; actions 404 on unknown runs", async () => {
    const store = new MemoryStateStore()
    await store.initInstance({
      instanceId: "q:c1",
      queueName: "q",
      jobName: "job",
      jobId: "c1",
      input: {},
    })
    const bull = fakeQueue()
    bull.seed("c1", "delayed")
    const queue = queueWith("q", store, bull)

    await queue.run("c1").cancel()
    expect((await store.getInstance("q:c1"))?.status).toBe("cancelled")
    expect(bull.jobs.has("c1")).toBe(false)

    await expect(queue.run("ghost").retry()).rejects.toMatchObject({ code: "not_found" })
  })
})
