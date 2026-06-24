import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryStateStore } from "../src/store/memory-store"
import type { StepState } from "../src/types"

const INSTANCE = "test:1"

function init(store: MemoryStateStore) {
  return store.initInstance({
    instanceId: INSTANCE,
    queueName: "test",
    jobName: "job",
    jobId: "1",
    input: { hello: "world" },
  })
}

describe("MemoryStateStore", () => {
  let store: MemoryStateStore

  beforeEach(() => {
    store = new MemoryStateStore()
  })

  it("creates an instance and is idempotent", async () => {
    const created = await init(store)
    expect(created.status).toBe("running")
    expect(created.input).toEqual({ hello: "world" })
    expect(created.runCount).toBe(0)

    // Second init must not overwrite existing state.
    await store.updateInstance(INSTANCE, { runCount: 3 })
    const again = await init(store)
    expect(again.runCount).toBe(3)
  })

  it("returns null for unknown instances", async () => {
    expect(await store.getInstance("nope")).toBeNull()
    expect(await store.getSteps("nope")).toEqual([])
    expect(await store.getLogs("nope")).toEqual([])
  })

  it("clones state so callers cannot mutate internals", async () => {
    await init(store)
    const a = await store.getInstance(INSTANCE)
    ;(a!.input as Record<string, unknown>).hello = "mutated"
    const b = await store.getInstance(INSTANCE)
    expect((b!.input as Record<string, unknown>).hello).toBe("world")
  })

  it("transitions through complete / fail / cancel", async () => {
    await init(store)
    await store.completeInstance(INSTANCE, { ok: true })
    let instance = await store.getInstance(INSTANCE)
    expect(instance!.status).toBe("completed")
    expect(instance!.output).toEqual({ ok: true })
    expect(instance!.completedAt).toBeTypeOf("number")

    await store.failInstance(INSTANCE, new Error("nope"))
    instance = await store.getInstance(INSTANCE)
    expect(instance!.status).toBe("failed")
    expect(instance!.error?.message).toBe("nope")

    await store.cancelInstance(INSTANCE)
    expect((await store.getInstance(INSTANCE))!.status).toBe("cancelled")
  })

  it("allocates monotonic resume sequences", async () => {
    await init(store)
    expect(await store.nextResumeSeq(INSTANCE)).toBe(1)
    expect(await store.nextResumeSeq(INSTANCE)).toBe(2)
    expect(await store.nextResumeSeq(INSTANCE)).toBe(3)
  })

  it("stores and updates steps", async () => {
    await init(store)
    const step: StepState = { key: "a", type: "step", status: "running", attempts: 1 }
    await store.saveStep(INSTANCE, "a", step)
    expect((await store.getStep(INSTANCE, "a"))!.status).toBe("running")

    await store.updateStep(INSTANCE, "a", { status: "completed", result: 42 })
    const updated = await store.getStep(INSTANCE, "a")
    expect(updated!.status).toBe("completed")
    expect(updated!.result).toBe(42)
    expect((await store.getSteps(INSTANCE)).length).toBe(1)
  })

  it("appends logs and trims to maxLogs", async () => {
    await init(store)
    for (let i = 0; i < 5; i++) {
      await store.appendLog(INSTANCE, { message: `m${i}`, timestamp: i }, 3)
    }
    const logs = await store.getLogs(INSTANCE)
    expect(logs.map((l) => l.message)).toEqual(["m2", "m3", "m4"])
  })

  describe("locking", () => {
    it("is exclusive across tokens", async () => {
      expect(await store.acquireLock(INSTANCE, "A", 1000)).toBe(true)
      expect(await store.acquireLock(INSTANCE, "B", 1000)).toBe(false)
      // Re-entrant for the same token.
      expect(await store.acquireLock(INSTANCE, "A", 1000)).toBe(true)
    })

    it("releases only for the holding token", async () => {
      await store.acquireLock(INSTANCE, "A", 1000)
      await store.releaseLock(INSTANCE, "B") // wrong token: no-op
      expect(await store.acquireLock(INSTANCE, "B", 1000)).toBe(false)
      await store.releaseLock(INSTANCE, "A")
      expect(await store.acquireLock(INSTANCE, "B", 1000)).toBe(true)
    })

    it("expires after its ttl", async () => {
      vi.useFakeTimers()
      try {
        await store.acquireLock(INSTANCE, "A", 1000)
        vi.advanceTimersByTime(1001)
        expect(await store.acquireLock(INSTANCE, "B", 1000)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it("renews only while held", async () => {
      vi.useFakeTimers()
      try {
        await store.acquireLock(INSTANCE, "A", 1000)
        vi.advanceTimersByTime(800)
        expect(await store.renewLock(INSTANCE, "A", 1000)).toBe(true)
        vi.advanceTimersByTime(800) // would have expired without the renew
        expect(await store.acquireLock(INSTANCE, "B", 1000)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("retention", () => {
    afterEach(() => vi.useRealTimers())

    it("expires instances after the retention ttl", async () => {
      vi.useFakeTimers()
      await init(store)
      await store.expireInstance(INSTANCE, 1000)
      expect(await store.getInstance(INSTANCE)).not.toBeNull()
      vi.advanceTimersByTime(1001)
      expect(await store.getInstance(INSTANCE)).toBeNull()
    })
  })
})
