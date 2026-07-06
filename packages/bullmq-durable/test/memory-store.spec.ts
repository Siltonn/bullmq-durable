import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryStateStore } from "../src/store/memory-store"
import type { StepState } from "../src/types"

const INSTANCE = "test:1"

function init(store: MemoryStateStore, id = INSTANCE, jobId = "1") {
  return store.initInstance({
    instanceId: id,
    queueName: "test",
    jobName: "job",
    jobId,
    input: { hello: "world" },
  })
}

describe("MemoryStateStore", () => {
  let store: MemoryStateStore

  beforeEach(() => {
    store = new MemoryStateStore()
  })

  describe("initInstance (begin-tick semantics)", () => {
    it("creates a fresh instance as running with runCount 1", async () => {
      const created = await init(store)
      expect(created.status).toBe("running")
      expect(created.input).toEqual({ hello: "world" })
      expect(created.runCount).toBe(1)
    })

    it("bumps runCount and re-flips a yielded instance to running", async () => {
      await init(store)
      await store.updateInstance(INSTANCE, { status: "yielded" })
      const again = await init(store)
      expect(again.runCount).toBe(2)
      expect(again.status).toBe("running")
    })

    it("preserves the compensating status while still counting the tick", async () => {
      await init(store)
      await store.updateInstance(INSTANCE, { status: "compensating" })
      const again = await init(store)
      expect(again.status).toBe("compensating")
      expect(again.runCount).toBe(2)
    })

    it("returns terminal instances untouched", async () => {
      await init(store)
      await store.completeInstance(INSTANCE, { ok: true })
      const again = await init(store)
      expect(again.status).toBe("completed")
      expect(again.runCount).toBe(1) // no bump
    })
  })

  it("returns null for unknown instances", async () => {
    expect(await store.getInstance("nope")).toBeNull()
    expect(await store.getSteps("nope")).toEqual([])
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

  it("does not conjure an instance when updating or cancelling a missing one", async () => {
    expect(await store.updateInstance("missing", { status: "running" })).toBeNull()
    expect(await store.cancelInstance("missing")).toBe(false)
    expect(await store.completeInstance("missing", { ok: true })).toBe(false)
    expect(await store.getInstance("missing")).toBeNull()
  })

  it("preserves undefined output for a void completion", async () => {
    await init(store)
    await store.completeInstance(INSTANCE, undefined)
    const instance = await store.getInstance(INSTANCE)
    expect(instance?.status).toBe("completed")
    expect(instance?.output).toBeUndefined()
  })

  describe("terminal transitions are lock-token fenced", () => {
    it("rejects a terminal write from a token that lost the lock", async () => {
      await init(store)
      await store.acquireLock(INSTANCE, "new-holder", 60_000)

      expect(await store.completeInstance(INSTANCE, "zombie result", "zombie")).toBe(false)
      expect((await store.getInstance(INSTANCE))!.status).toBe("running")
    })

    it("accepts the holder's token and unfenced writes", async () => {
      await init(store)
      await store.acquireLock(INSTANCE, "holder", 60_000)

      expect(await store.failInstance(INSTANCE, new Error("boom"), "holder")).toBe(true)
      expect((await store.getInstance(INSTANCE))!.status).toBe("failed")

      // External (queue-side) cancel passes no token and always applies.
      await init(store, "test:2", "2")
      expect(await store.cancelInstance("test:2")).toBe(true)
    })
  })

  describe("beginStep", () => {
    it("creates a running step with an allocated seq in one call", async () => {
      await init(store)
      const result = await store.beginStep(INSTANCE, "a", {
        key: "a",
        type: "step",
        phase: "main",
        now: 123,
      })
      expect(result).toEqual({ kind: "created", seq: 1 })

      const step = await store.getStep(INSTANCE, "a")
      expect(step).toMatchObject({ key: "a", status: "running", attempts: 1, startedAt: 123 })

      const second = await store.beginStep(INSTANCE, "b", {
        key: "b",
        type: "step",
        phase: "main",
        now: 124,
      })
      expect(second).toEqual({ kind: "created", seq: 2 })
    })

    it("returns existing state instead of re-creating", async () => {
      await init(store)
      await store.beginStep(INSTANCE, "a", { key: "a", type: "step", phase: "main", now: 1 })
      await store.updateStep(INSTANCE, "a", { status: "completed", result: 42 })

      const replay = await store.beginStep(INSTANCE, "a", {
        key: "a",
        type: "step",
        phase: "main",
        now: 2,
      })
      expect(replay.kind).toBe("existing")
      if (replay.kind === "existing") {
        expect(replay.step.status).toBe("completed")
        expect(replay.step.result).toBe(42)
      }
    })

    it("persists nextRunAt for sleeps at creation", async () => {
      await init(store)
      await store.beginStep(INSTANCE, "nap", {
        key: "nap",
        type: "sleep",
        phase: "main",
        now: 100,
        nextRunAt: 5100,
      })
      expect((await store.getStep(INSTANCE, "nap"))!.nextRunAt).toBe(5100)
    })

    it("reports cancelled / missing instances", async () => {
      expect(
        await store.beginStep("missing", "a", { key: "a", type: "step", phase: "main", now: 1 }),
      ).toEqual({ kind: "missing" })

      await init(store)
      await store.cancelInstance(INSTANCE)
      expect(
        await store.beginStep(INSTANCE, "a", { key: "a", type: "step", phase: "main", now: 1 }),
      ).toEqual({ kind: "cancelled" })
    })
  })

  it("returns steps ordered by seq (startedAt fallback)", async () => {
    await init(store)
    await store.saveStep(INSTANCE, "second", {
      key: "second",
      type: "step",
      status: "completed",
      attempts: 1,
      startedAt: 200,
    })
    await store.saveStep(INSTANCE, "first", {
      key: "first",
      type: "step",
      status: "completed",
      attempts: 1,
      startedAt: 100,
    })
    expect((await store.getSteps(INSTANCE)).map((s) => s.key)).toEqual(["first", "second"])
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

  describe("reaper primitives (state follows the job)", () => {
    it("lists active and terminal instances separately, oldest terminal first", async () => {
      await init(store, "test:a", "a")
      await init(store, "test:b", "b")
      await init(store, "test:c", "c")

      await store.completeInstance("test:a", 1)
      await new Promise((resolve) => setTimeout(resolve, 2))
      await store.completeInstance("test:b", 2)

      expect(await store.listActive("test")).toEqual(["test:c"])
      expect(await store.listOldestTerminal("test", "completed", 10)).toEqual(["test:a", "test:b"])
      expect(await store.listOldestTerminal("test", "completed", 1)).toEqual(["test:a"])
      expect(await store.listOldestTerminal("test", "failed", 10)).toEqual([])
    })

    it("removeInstances deletes state and locks", async () => {
      await init(store)
      await store.saveStep(INSTANCE, "a", {
        key: "a",
        type: "step",
        status: "completed",
        attempts: 1,
      })
      await store.completeInstance(INSTANCE, "done")

      await store.removeInstances("test", [INSTANCE])
      expect(await store.getInstance(INSTANCE)).toBeNull()
      expect(await store.getSteps(INSTANCE)).toEqual([])
      expect(await store.listOldestTerminal("test", "completed", 10)).toEqual([])
    })

    it("wipeAll clears everything", async () => {
      await init(store, "test:a", "a")
      await init(store, "test:b", "b")
      await store.completeInstance("test:a", 1)

      await store.wipeAll()
      expect(await store.listActive("test")).toEqual([])
      expect(await store.listOldestTerminal("test", "completed", 10)).toEqual([])
      expect(await store.getInstance("test:b")).toBeNull()
    })
  })
})
