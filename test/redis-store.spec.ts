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

  it("drives a full durable flow (step + sleep + retry) end to end", async () => {
    const engine = new TestEngine(
      async (_job: DurableJob, ctx: DurableContext) => {
        await ctx.step("create", async () => ({ taskId: "t1" }))
        await ctx.sleep("wait", "10s")
        let polls = 0
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
