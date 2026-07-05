/**
 * Integration tests for {@link RedisStateStore}.
 *
 * These require a reachable Redis. When none is available (e.g. CI without a
 * Redis service) the whole suite is skipped rather than failing, so the unit
 * suite stays self-contained. Point them at a server with REDIS_HOST/REDIS_PORT.
 */

import { Redis } from "ioredis"
import { afterAll, describe, expect, it } from "vitest"
import type { DurableContext, DurableJob } from "../src/index"
import { DurableQueue } from "../src/index"
import { DurableReaper, bullJobsExist } from "../src/reaper"
import { RedisStateStore } from "../src/store/redis-store"
import type { StepState } from "../src/types"
import { TestEngine } from "./helpers/engine"

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1"
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379)

async function canConnect(): Promise<boolean> {
  const client = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  // Swallow connection errors so an unreachable Redis stays quiet.
  client.on("error", () => undefined)
  try {
    await client.connect()
    await client.ping()
    return true
  } catch {
    return false
  } finally {
    client.disconnect()
  }
}

const available = await canConnect()
const describeRedis = available ? describe : describe.skip

if (!available) {
  console.warn(
    `[redis-store.spec] Redis unreachable at ${REDIS_HOST}:${REDIS_PORT} — skipping integration tests`,
  )
}

describeRedis("RedisStateStore (integration)", () => {
  const prefix = `bmqd-test:${Date.now()}`
  const admin = new Redis({ host: REDIS_HOST, port: REDIS_PORT })
  const store = new RedisStateStore({ connection: { host: REDIS_HOST, port: REDIS_PORT }, prefix })

  let counter = 0
  const newId = () => `q:${counter++}`

  afterAll(async () => {
    const keys = await admin.keys(`${prefix}*`)
    if (keys.length > 0) await admin.del(...keys)
    await admin.quit()
    await store.close()
  })

  async function init(instanceId: string) {
    return store.initInstance({
      instanceId,
      queueName: "q",
      jobName: "job",
      jobId: instanceId,
      input: { hello: "world" },
    })
  }

  it("begin-tick: creates fresh (runCount 1), bumps on re-delivery, keeps terminal untouched", async () => {
    const id = newId()
    const created = await init(id)
    expect(created.status).toBe("running")
    expect(created.input).toEqual({ hello: "world" })
    expect(created.runCount).toBe(1)

    await store.updateInstance(id, { status: "yielded" })
    const second = await init(id)
    expect(second.runCount).toBe(2)
    expect(second.status).toBe("running")

    await store.updateInstance(id, { status: "compensating" })
    const third = await init(id)
    expect(third.status).toBe("compensating") // preserved
    expect(third.runCount).toBe(3)

    await store.completeInstance(id, { ok: true })
    const fourth = await init(id)
    expect(fourth.status).toBe("completed")
    expect(fourth.runCount).toBe(3) // terminal: no bump
  })

  it("transitions through complete / fail / cancel", async () => {
    const id = newId()
    await init(id)

    await store.completeInstance(id, { ok: true })
    expect((await store.getInstance(id))?.output).toEqual({ ok: true })

    await store.failInstance(id, new Error("boom"))
    expect((await store.getInstance(id))?.error?.message).toBe("boom")

    await store.cancelInstance(id)
    expect((await store.getInstance(id))?.status).toBe("cancelled")
  })

  it("compensating → compensation_failed: persists fields and moves the index bucket", async () => {
    const id = newId()
    await init(id)

    // Entering the compensating phase keeps the instance in the active set and
    // persists the triggering error / failed step.
    await store.updateInstance(id, {
      status: "compensating",
      failureError: { name: "Error", message: "boom" },
      failedStep: "poll",
      compensation: {
        rolledBack: ["reserve"],
        failed: [
          { key: "charge", status: "failed", error: { name: "Error", message: "refund down" } },
        ],
      },
    })
    expect(await admin.sismember(`${prefix}:idx:q:active`, id)).toBe(1)

    await store.compensationFailedInstance(id, new Error("boom"))
    const inst = await store.getInstance(id)
    expect(inst?.status).toBe("compensation_failed")
    expect(inst?.failureError?.message).toBe("boom")
    expect(inst?.failedStep).toBe("poll")
    expect(inst?.compensation?.rolledBack).toEqual(["reserve"])
    expect(inst?.compensation?.failed[0]?.key).toBe("charge")

    // Terminal: out of the active set, into its own done bucket.
    expect(await admin.sismember(`${prefix}:idx:q:active`, id)).toBe(0)
    expect(await admin.zscore(`${prefix}:idx:q:done:compensation_failed`, id)).not.toBeNull()
  })

  it("does not conjure a 'zombie' instance when updating a missing one", async () => {
    const id = newId()
    // Updating/cancelling before the instance exists must be a no-op (matching
    // the in-memory store), not an HSET that creates a half-populated hash.
    expect(await store.updateInstance(id, { status: "running" })).toBeNull()
    expect(await store.cancelInstance(id)).toBe(false)
    expect(await store.getInstance(id)).toBeNull()

    // A subsequent real init then creates a clean, complete instance.
    const created = await init(id)
    expect(created.status).toBe("running")
    expect(created.input).toEqual({ hello: "world" })
  })

  it("preserves undefined output for a void completion", async () => {
    const id = newId()
    await init(id)
    await store.completeInstance(id, undefined)
    const instance = await store.getInstance(id)
    expect(instance?.status).toBe("completed")
    expect(instance?.output).toBeUndefined()
  })

  it("stores and updates steps", async () => {
    const id = newId()
    await init(id)
    const step: StepState = { key: "a", type: "step", status: "running", attempts: 1 }
    await store.saveStep(id, "a", step)
    await store.updateStep(id, "a", { status: "completed", result: { v: 1 } })

    const stored = await store.getStep(id, "a")
    expect(stored?.status).toBe("completed")
    expect(stored?.result).toEqual({ v: 1 })
    expect(await store.getSteps(id)).toHaveLength(1)
  })

  it("fails loudly, with locating context, on a corrupted JSON field", async () => {
    const id = newId()
    await init(id)
    await admin.hset(`${prefix}:instance:${id}`, "output", "{not json")
    await expect(store.getInstance(id)).rejects.toThrow(
      new RegExp(`corrupted JSON in instance "${id}" field "output"`),
    )
  })

  describe("beginStep", () => {
    it("creates a running step (allocated seq) in one round-trip", async () => {
      const id = newId()
      await init(id)

      const first = await store.beginStep(id, "a", {
        key: "a",
        type: "step",
        phase: "main",
        now: 123,
      })
      expect(first).toEqual({ kind: "created", seq: 1 })
      expect(await store.getStep(id, "a")).toMatchObject({
        key: "a",
        type: "step",
        status: "running",
        attempts: 1,
        seq: 1,
        startedAt: 123,
      })

      const second = await store.beginStep(id, "b", {
        key: "b",
        type: "step",
        phase: "main",
        now: 124,
      })
      expect(second).toEqual({ kind: "created", seq: 2 })
    })

    it("returns existing state, honours sleeps' nextRunAt, reports cancelled/missing", async () => {
      const id = newId()
      await init(id)

      await store.beginStep(id, "nap", {
        key: "nap",
        type: "sleep",
        phase: "main",
        now: 100,
        nextRunAt: 5_100,
      })
      const replay = await store.beginStep(id, "nap", {
        key: "nap",
        type: "sleep",
        phase: "main",
        now: 200,
      })
      expect(replay.kind).toBe("existing")
      if (replay.kind === "existing") expect(replay.step.nextRunAt).toBe(5_100)

      expect(
        await store.beginStep("missing:x", "a", { key: "a", type: "step", phase: "main", now: 1 }),
      ).toEqual({ kind: "missing" })

      await store.cancelInstance(id)
      expect(
        await store.beginStep(id, "z", { key: "z", type: "step", phase: "main", now: 1 }),
      ).toEqual({ kind: "cancelled" })
    })
  })

  it("provides an exclusive, re-entrant lock", async () => {
    const id = newId()
    expect(await store.acquireLock(id, "A", 5_000)).toBe(true)
    expect(await store.acquireLock(id, "B", 5_000)).toBe(false)
    expect(await store.acquireLock(id, "A", 5_000)).toBe(true) // re-entrant
    expect(await store.renewLock(id, "A", 5_000)).toBe(true)
    expect(await store.renewLock(id, "B", 5_000)).toBe(false)
    await store.releaseLock(id, "A")
    expect(await store.acquireLock(id, "B", 5_000)).toBe(true)
  })

  it("fences terminal transitions with the lock token", async () => {
    const id = newId()
    await init(id)
    await store.acquireLock(id, "new-holder", 60_000)

    // A zombie whose lock was taken over cannot flip the state...
    expect(await store.completeInstance(id, "zombie", "zombie-token")).toBe(false)
    expect((await store.getInstance(id))?.status).toBe("running")
    // ...the rightful holder can; and an unfenced (queue-side) write also can.
    expect(await store.failInstance(id, new Error("boom"), "new-holder")).toBe(true)
    expect((await store.getInstance(id))?.status).toBe("failed")
  })

  const zscore = async (bucket: string, id: string): Promise<number | null> => {
    const s = await admin.zscore(`${prefix}:idx:q:done:${bucket}`, id)
    return s === null ? null : Number(s)
  }

  it("terminal transition moves active -> done bucket scored by transition time, no TTL", async () => {
    const id = newId()
    await init(id)
    expect(await admin.sismember(`${prefix}:idx:q:active`, id)).toBe(1)

    const before = Date.now()
    await store.completeInstance(id, { ok: true })
    const after = Date.now()

    expect(await admin.sismember(`${prefix}:idx:q:active`, id)).toBe(0)
    const score = await zscore("completed", id)
    expect(score).not.toBeNull()
    expect(score!).toBeGreaterThanOrEqual(before)
    expect(score!).toBeLessThanOrEqual(after)
    // State follows the job — no self-expiry on the data keys.
    expect(await admin.pttl(`${prefix}:instance:${id}`)).toBe(-1)
  })

  it("clears a stale done entry when a reused id is re-created", async () => {
    const id = newId()
    await init(id)
    await store.completeInstance(id, { ok: true })
    expect(await zscore("completed", id)).not.toBeNull()

    // Simulate the hash being reaped while the index entry lingers, then
    // re-enqueue the same id (a reused BullMQ job id).
    await admin.del(`${prefix}:instance:${id}`)
    await init(id)

    expect(await admin.sismember(`${prefix}:idx:q:active`, id)).toBe(1)
    expect(await zscore("completed", id)).toBeNull() // no phantom "done" double-count
  })

  describe("reaper primitives", () => {
    it("lists oldest terminal first and removes instances (incl. legacy logs key)", async () => {
      const a = newId()
      const b = newId()
      await init(a)
      await init(b)
      await store.completeInstance(a, 1)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await store.completeInstance(b, 2)

      const oldest = await store.listOldestTerminal("q", "completed", 10)
      expect(oldest.indexOf(a)).toBeLessThan(oldest.indexOf(b))

      // A leftover 0.1.x logs list rides along on removal.
      await admin.rpush(`${prefix}:logs:${a}`, "legacy line")
      await store.removeInstances("q", [a])
      expect(await store.getInstance(a)).toBeNull()
      expect(await admin.exists(`${prefix}:logs:${a}`)).toBe(0)
      expect(await zscore("completed", a)).toBeNull()
      expect((await store.listOldestTerminal("q", "completed", 10)).includes(b)).toBe(true)
    })

    it("listActive reflects the active set; wipeAll clears everything", async () => {
      const wipePrefix = `${prefix}:wipe`
      const wipeStore = new RedisStateStore({
        connection: { host: REDIS_HOST, port: REDIS_PORT },
        prefix: wipePrefix,
      })
      try {
        await wipeStore.initInstance({
          instanceId: "q:w1",
          queueName: "q",
          jobName: "job",
          jobId: "w1",
          input: {},
        })
        await wipeStore.initInstance({
          instanceId: "q:w2",
          queueName: "q",
          jobName: "job",
          jobId: "w2",
          input: {},
        })
        await wipeStore.completeInstance("q:w1", 1)

        expect(await wipeStore.listActive("q")).toEqual(["q:w2"])

        await wipeStore.wipeAll()
        expect(await wipeStore.listActive("q")).toEqual([])
        expect(await wipeStore.listOldestTerminal("q", "completed", 10)).toEqual([])
        expect(await wipeStore.getInstance("q:w2")).toBeNull()
      } finally {
        await wipeStore.close()
      }
    })
  })

  describe("state follows the job (DurableQueue integration)", () => {
    it("clean() removes durable state for the removed jobs, exactly", async () => {
      const queue = new DurableQueue("rq-clean", {
        connection: { host: REDIS_HOST, port: REDIS_PORT },
        stateStore: store,
      })
      try {
        await queue.add("job", { n: 1 }, { jobId: "c1", delay: 3_600_000 })
        await queue.add("job", { n: 2 }, { jobId: "c2", delay: 3_600_000 })
        await store.initInstance({
          instanceId: queue.instanceIdFor("c1"),
          queueName: "rq-clean",
          jobName: "job",
          jobId: "c1",
          input: { n: 1 },
        })
        await store.initInstance({
          instanceId: queue.instanceIdFor("c2"),
          queueName: "rq-clean",
          jobName: "job",
          jobId: "c2",
          input: { n: 2 },
        })

        const removed = await queue.clean(0, 100, "delayed")
        expect(removed.sort()).toEqual(["c1", "c2"])
        expect(await store.getInstance(queue.instanceIdFor("c1"))).toBeNull()
        expect(await store.getInstance(queue.instanceIdFor("c2"))).toBeNull()
      } finally {
        await queue.bull.obliterate({ force: true }).catch(() => undefined)
        await queue.close()
      }
    })

    it("reaper deletes terminal state once its job is gone, in oldest-first order", async () => {
      const queue = new DurableQueue("rq-reap", {
        connection: { host: REDIS_HOST, port: REDIS_PORT },
        stateStore: store,
      })
      try {
        const iid = queue.instanceIdFor("r1")
        await queue.add("job", {}, { jobId: "r1", delay: 3_600_000 })
        await store.initInstance({
          instanceId: iid,
          queueName: "rq-reap",
          jobName: "job",
          jobId: "r1",
          input: {},
        })
        await store.completeInstance(iid, "done")

        const reaper = new DurableReaper({
          store,
          queueName: "rq-reap",
          jobsExist: bullJobsExist(queue.bull),
        })

        // Job still exists → state survives.
        await reaper.reapTerminal()
        expect(await store.getInstance(iid)).not.toBeNull()

        // Job removed → state follows.
        await (await queue.bull.getJob("r1"))?.remove()
        await reaper.reapTerminal()
        expect(await store.getInstance(iid)).toBeNull()
      } finally {
        await queue.bull.obliterate({ force: true }).catch(() => undefined)
        await queue.close()
      }
    })

    it("reconcileActive spares a run still carried by its legacy 0.1.x resume job", async () => {
      const queue = new DurableQueue("rq-legacy-carrier", {
        connection: { host: REDIS_HOST, port: REDIS_PORT },
        stateStore: store,
      })
      try {
        const iid = queue.instanceIdFor("lg1")
        await store.initInstance({
          instanceId: iid,
          queueName: "rq-legacy-carrier",
          jobName: "job",
          jobId: "lg1",
          input: {},
        })
        // Aged, no primary job — but the legacy carrier exists (delayed).
        await admin.hset(`${prefix}:instance:${iid}`, {
          resumeSeq: "2",
          updatedAt: String(Date.now() - 120_000),
        })
        await queue.bull.add(
          "job",
          { __durable__: { instanceId: iid, originalJobId: "lg1", resumeSeq: 2 }, payload: {} },
          { jobId: "lg1:resume:2", delay: 3_600_000 },
        )

        const reaper = new DurableReaper({
          store,
          queueName: "rq-legacy-carrier",
          jobsExist: bullJobsExist(queue.bull),
          graceMs: 60_000,
        })
        await reaper.pass(true)

        // NOT cancelled/reaped: the legacy carrier still owns the run.
        expect((await store.getInstance(iid))?.status).toBe("running")
      } finally {
        await queue.bull.obliterate({ force: true }).catch(() => undefined)
        await queue.close()
      }
    })

    it("reconcileActive cancels (then reaps) a non-terminal orphan past the grace window", async () => {
      const queue = new DurableQueue("rq-orphan", {
        connection: { host: REDIS_HOST, port: REDIS_PORT },
        stateStore: store,
      })
      try {
        const iid = queue.instanceIdFor("o1")
        await store.initInstance({
          instanceId: iid,
          queueName: "rq-orphan",
          jobName: "job",
          jobId: "o1",
          input: {},
        })
        // No bull job exists for o1 (hand-deleted). Age the instance past grace.
        await store.updateInstance(iid, { updatedAt: Date.now() - 120_000 })
        await admin.hset(`${prefix}:instance:${iid}`, "updatedAt", String(Date.now() - 120_000))

        const reaper = new DurableReaper({
          store,
          queueName: "rq-orphan",
          jobsExist: bullJobsExist(queue.bull),
          graceMs: 60_000,
        })
        await reaper.pass(true)

        expect(await store.getInstance(iid)).toBeNull() // cancelled, then reaped
      } finally {
        await queue.bull.obliterate({ force: true }).catch(() => undefined)
        await queue.close()
      }
    })
  })

  it("cancel() finds and removes a legacy 0.1.x resume job via the resumeSeq fallback", async () => {
    const queue = new DurableQueue("rq-legacy-cancel", {
      connection: { host: REDIS_HOST, port: REDIS_PORT },
      stateStore: store,
    })
    try {
      const iid = queue.instanceIdFor("1")
      await store.initInstance({
        instanceId: iid,
        queueName: "rq-legacy-cancel",
        jobName: "job",
        jobId: "1",
        input: {},
      })
      // A 0.1.x deployment left resumeSeq=2 on the instance and a delayed
      // resume job carrying the envelope.
      await admin.hset(`${prefix}:instance:${iid}`, "resumeSeq", "2")
      await queue.bull.add(
        "job",
        { __durable__: { instanceId: iid, originalJobId: "1", resumeSeq: 2 }, payload: {} },
        { jobId: "1:resume:2", delay: 3_600_000 },
      )
      expect(await queue.bull.getJob("1:resume:2")).toBeTruthy()

      await queue.cancel("1")

      expect(await queue.bull.getJob("1:resume:2")).toBeFalsy()
      expect((await store.getInstance(iid))?.status).toBe("cancelled")
    } finally {
      await queue.bull.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
    }
  })

  it("drives a full durable flow (step + sleep + retry) end to end", async () => {
    // `polls` lives across ticks: each re-delivery re-enters the processor and
    // the poll step is retried until the condition holds.
    let polls = 0
    const engine = new TestEngine(
      async (_job: DurableJob, ctx: DurableContext) => {
        await ctx.step("create", async () => ({ taskId: "t1" }))
        await ctx.sleep("wait", "10s")
        const result = await ctx.step(
          "poll",
          { retry: { attempts: 5, backoff: "1s" } },
          async () => {
            polls++
            if (polls < 2) throw ctx.retryLater("pending")
            return { done: true }
          },
        )
        return result
      },
      { store, queueName: "flow" },
    )

    const { outcome, instance } = await engine.run("job", { userId: "u1" }, newId())
    expect(outcome.type).toBe("completed")
    expect(instance?.status).toBe("completed")
    expect(instance?.output).toEqual({ done: true })
  })
})
