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

  it("creates and reads an instance, idempotently", async () => {
    const id = newId()
    const created = await init(id)
    expect(created.status).toBe("running")
    expect(created.input).toEqual({ hello: "world" })

    await store.updateInstance(id, { runCount: 4 })
    const again = await init(id)
    expect(again.runCount).toBe(4)
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
    expect(await admin.sismember(`${prefix}:idx:active`, id)).toBe(1)

    await store.compensationFailedInstance(id, new Error("boom"))
    const inst = await store.getInstance(id)
    expect(inst?.status).toBe("compensation_failed")
    expect(inst?.failureError?.message).toBe("boom")
    expect(inst?.failedStep).toBe("poll")
    expect(inst?.compensation?.rolledBack).toEqual(["reserve"])
    expect(inst?.compensation?.failed[0]?.key).toBe("charge")

    // Terminal: out of the active set, into its own done bucket.
    expect(await admin.sismember(`${prefix}:idx:active`, id)).toBe(0)
    expect(await admin.zscore(`${prefix}:idx:done:compensation_failed`, id)).not.toBeNull()
  })

  it("does not conjure a 'zombie' instance when updating a missing one", async () => {
    const id = newId()
    // Updating/cancelling before the instance exists must be a no-op (matching
    // the in-memory store), not an HSET that creates a half-populated hash.
    expect(await store.updateInstance(id, { status: "running" })).toBeNull()
    await store.cancelInstance(id)
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

  it("keeps no logs when maxLogs is 0", async () => {
    const id = newId()
    await init(id)
    await store.appendLog(id, { message: "x", timestamp: 1 }, 0)
    expect(await store.getLogs(id)).toEqual([])
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

  it("allocates monotonic resume sequences", async () => {
    const id = newId()
    await init(id)
    expect(await store.nextResumeSeq(id)).toBe(1)
    expect(await store.nextResumeSeq(id)).toBe(2)
  })

  it("appends and trims logs", async () => {
    const id = newId()
    await init(id)
    for (let i = 0; i < 5; i++) {
      await store.appendLog(id, { message: `m${i}`, timestamp: i }, 3)
    }
    expect((await store.getLogs(id)).map((l) => l.message)).toEqual(["m2", "m3", "m4"])
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

  it("sets a retention ttl on instance keys", async () => {
    const id = newId()
    await init(id)
    await store.expireInstance(id, 60_000)
    const ttl = await admin.pttl(`${prefix}:instance:${id}`)
    expect(ttl).toBeGreaterThan(0)
  })

  const zscore = async (bucket: string, id: string): Promise<number | null> => {
    const s = await admin.zscore(`${prefix}:idx:done:${bucket}`, id)
    return s === null ? null : Number(s)
  }

  it("moves an instance active -> done bucket (scored by expiry) + TTL on a terminal transition", async () => {
    const id = newId()
    await init(id)
    expect(await admin.sismember(`${prefix}:idx:active`, id)).toBe(1)

    const before = Date.now()
    await store.completeInstance(id, { ok: true }, 60_000)

    // Atomic: left the active set, entered done:completed scored by real expiry,
    // and the data key got a TTL — all in one transition (no sentinel/no leak).
    expect(await admin.sismember(`${prefix}:idx:active`, id)).toBe(0)
    const score = await zscore("completed", id)
    expect(score).not.toBeNull()
    expect(score ?? 0).toBeGreaterThanOrEqual(before + 60_000)
    expect(await admin.pttl(`${prefix}:instance:${id}`)).toBeGreaterThan(0)
  })

  it("clears a stale done entry when a reused id is re-created", async () => {
    const id = newId()
    await init(id)
    await store.completeInstance(id, { ok: true }, 60_000)
    expect(await zscore("completed", id)).not.toBeNull()

    // Simulate the hash expiring while the lingering index entry survives, then
    // re-enqueue the same id (a reused BullMQ job id).
    await admin.del(`${prefix}:instance:${id}`)
    await init(id)

    expect(await admin.sismember(`${prefix}:idx:active`, id)).toBe(1)
    expect(await zscore("completed", id)).toBeNull() // no phantom "done" double-count
  })

  it("applies cancelled retention + index move on an external queue.cancel()", async () => {
    const queue = new DurableQueue("rq-cancel-ret", {
      connection: { host: REDIS_HOST, port: REDIS_PORT },
      stateStore: store,
    })
    try {
      const id = queue.instanceIdFor("1")
      await store.initInstance({
        instanceId: id,
        queueName: "rq-cancel-ret",
        jobName: "job",
        jobId: "1",
        input: {},
      })
      await queue.cancel("1")

      expect(await admin.sismember(`${prefix}:idx:active`, id)).toBe(0)
      expect(await zscore("cancelled", id)).not.toBeNull()
      expect(await admin.pttl(`${prefix}:instance:${id}`)).toBeGreaterThan(0)
    } finally {
      await queue.bull.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
    }
  })

  it("schedules resume jobs with attempts > 1 so a failed resume tick self-heals", async () => {
    const queue = new DurableQueue("rq-resume", {
      connection: { host: REDIS_HOST, port: REDIS_PORT },
    })
    try {
      await queue.scheduleResume({
        instanceId: "rq-resume:1",
        queueName: "rq-resume",
        jobName: "job",
        jobData: { a: 1 },
        originalJobId: "1",
        resumeSeq: 1,
        delayMs: 60_000,
        reason: "test",
      })
      const delayed = await queue.bull.getDelayed()
      const job = delayed.find((j) => j.id === "1:resume:1")
      expect(job?.opts.attempts).toBe(3) // default DEFAULT_RESUME_ATTEMPTS
    } finally {
      await queue.bull.obliterate({ force: true })
      await queue.close()
    }
  })

  it("cancel() removes the pending resume job by exact id (no delayed-set scan)", async () => {
    const queue = new DurableQueue("rq-cancel", {
      connection: { host: REDIS_HOST, port: REDIS_PORT },
      stateStore: store,
    })
    try {
      const instanceId = queue.instanceIdFor("1")
      await store.initInstance({
        instanceId,
        queueName: "rq-cancel",
        jobName: "job",
        jobId: "1",
        input: {},
      })
      // Simulate one yield: allocate resumeSeq=1 and enqueue its delayed resume.
      await store.nextResumeSeq(instanceId)
      await queue.scheduleResume({
        instanceId,
        queueName: "rq-cancel",
        jobName: "job",
        jobData: {},
        originalJobId: "1",
        resumeSeq: 1,
        delayMs: 60_000,
        reason: "test",
      })
      expect(await queue.bull.getJob("1:resume:1")).toBeTruthy()

      await queue.cancel("1")

      expect(await queue.bull.getJob("1:resume:1")).toBeFalsy()
      expect((await store.getInstance(instanceId))?.status).toBe("cancelled")
    } finally {
      await queue.bull.obliterate({ force: true })
      await queue.close()
    }
  })

  it("drives a full durable flow (step + sleep + retry) end to end", async () => {
    // `polls` lives across ticks: each resume re-enters the processor and the
    // poll step is retried until the condition holds.
    let polls = 0
    const engine = new TestEngine(
      async (_job: DurableJob, ctx: DurableContext) => {
        await ctx.step("create", async () => ({ taskId: "t1" }))
        await ctx.sleep("wait", "10s")
        const result = await ctx.step("poll", { retry: { attempts: 5, delay: "1s" } }, async () => {
          polls++
          if (polls < 2) throw ctx.retryLater("pending")
          return { done: true }
        })
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
