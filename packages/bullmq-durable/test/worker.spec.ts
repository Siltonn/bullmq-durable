import { describe, expect, it, vi } from "vitest"
import type { DurableContext, DurableJob, StateStore } from "../src/index"
import { MemoryStateStore } from "../src/index"
import { resolveDurableProcessor, runOutcomeToReturn } from "../src/worker"
import { parseDuration } from "../src/utils/duration"
import { TestEngine } from "./helpers/engine"

describe("runOutcomeToReturn", () => {
  it("returns the output for completed instances", () => {
    expect(runOutcomeToReturn({ type: "completed", output: 42 })).toBe(42)
  })

  it("throws only on a fresh failure", () => {
    const error = new Error("boom")
    expect(() => runOutcomeToReturn({ type: "failed", error, fresh: true })).toThrow("boom")
    expect(runOutcomeToReturn({ type: "failed", error, fresh: false })).toBeUndefined()
  })

  it("returns undefined for yielded / cancelled / skipped", () => {
    expect(runOutcomeToReturn({ type: "yielded" })).toBeUndefined()
    expect(runOutcomeToReturn({ type: "cancelled" })).toBeUndefined()
    expect(runOutcomeToReturn({ type: "skipped" })).toBeUndefined()
  })
})

describe("resolveDurableProcessor", () => {
  const fn = async () => "ok"

  it("returns a single function for any job name", () => {
    expect(resolveDurableProcessor(fn, "anything", "q")).toBe(fn)
  })

  it("routes by job name for a handler map", () => {
    const handlers = { video: fn, image: async () => "img" }
    expect(resolveDurableProcessor(handlers, "video", "q")).toBe(fn)
  })

  it("throws for an unknown job name in a handler map", () => {
    expect(() => resolveDurableProcessor({ video: fn }, "missing", "generation")).toThrow(
      /no processor registered for job "missing"/,
    )
  })
})

describe("instance lifecycle", () => {
  it("skips when another worker holds the instance lock", async () => {
    const ran: string[] = []
    const engine = new TestEngine(async () => {
      ran.push("run")
      return "done"
    })
    const instanceId = engine.instanceId("1")
    await engine.store.initInstance({
      instanceId,
      queueName: engine.queueName,
      jobName: "job",
      jobId: "1",
      input: {},
    })
    await engine.store.acquireLock(instanceId, "other-worker", 60_000)

    const outcome = await engine.start("job", {}, "1")
    expect(outcome.type).toBe("skipped")
    expect(ran).toEqual([])
  })

  it("releases the lock after a tick finishes", async () => {
    const engine = new TestEngine(async () => "done")
    await engine.run("job", {}, "1")
    expect(await engine.store.acquireLock(engine.instanceId("1"), "anyone", 1_000)).toBe(true)
  })

  it("releases the lock before enqueueing a yielded resume", async () => {
    // Guards the ordering that prevents a zero-delay resume from being skipped
    // by a worker contending for a lock the yielding tick still holds.
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleep("wait", "10s")
      return "done"
    })
    await engine.start("job", {}, "1")

    expect(engine.pendingCount).toBe(1) // a resume is queued
    // ...and the lock is already free, so the resume can acquire it.
    expect(await engine.store.acquireLock(engine.instanceId("1"), "next", 1_000)).toBe(true)
  })

  it("is idempotent for a stray resume of a completed instance", async () => {
    let runs = 0
    const engine = new TestEngine(async () => {
      runs++
      return "done"
    })
    await engine.run("job", {}, "1")
    const strayOutcome = await engine.start("job", {}, "1")

    expect(runs).toBe(1) // processor not re-run
    expect(strayOutcome).toEqual({ type: "completed", output: "done" })
  })

  it("stops at the next step once an instance is cancelled", async () => {
    const ran: string[] = []
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("a", async () => {
        ran.push("a")
        return 1
      })
      await ctx.sleep("wait", "10s")
      await ctx.step("b", async () => {
        ran.push("b")
        return 2
      })
      return "done"
    })

    await engine.start("job", {}, "1") // runs "a", then sleeps
    expect(ran).toEqual(["a"])

    await engine.store.cancelInstance(engine.instanceId("1"))
    const { last } = await engine.drain()

    expect(last?.type).toBe("cancelled")
    expect(ran).toEqual(["a"]) // "b" never runs
    expect((await engine.store.getInstance(engine.instanceId("1")))?.status).toBe("cancelled")
  })
})

describe("retention", () => {
  it("expires a completed instance using the completed ttl", async () => {
    const store = new MemoryStateStore()
    const spy = vi.spyOn(store, "expireInstance")
    const engine = new TestEngine(async () => "done", {
      store,
      retention: { completed: "7d", failed: "30d" },
    })
    await engine.run("job", {}, "1")
    expect(spy).toHaveBeenCalledWith(engine.instanceId("1"), parseDuration("7d"))
  })

  it("expires a failed instance using the failed ttl", async () => {
    const store = new MemoryStateStore()
    const spy = vi.spyOn(store, "expireInstance")
    const engine = new TestEngine(
      async () => {
        throw new Error("nope")
      },
      { store, retention: { completed: "7d", failed: "30d" } },
    )
    await engine.run("job", {}, "1")
    expect(spy).toHaveBeenCalledWith(engine.instanceId("1"), parseDuration("30d"))
  })
})

describe("custom state store", () => {
  it("routes all persistence through a user-supplied StateStore", async () => {
    const calls = new Set<string>()
    const store = recordingStore(new MemoryStateStore(), calls)

    const engine = new TestEngine(
      async (_job: DurableJob, ctx: DurableContext) => {
        await ctx.step("a", async () => 1)
        return "done"
      },
      { store },
    )

    const { instance } = await engine.run("job", {}, "1")
    expect(instance?.status).toBe("completed")
    expect(calls.has("initInstance")).toBe(true)
    expect(calls.has("saveStep")).toBe(true)
    expect(calls.has("completeInstance")).toBe(true)
    expect(calls.has("acquireLock")).toBe(true)
  })
})

describe("ctx.log", () => {
  it("persists structured logs and mirrors them to the job", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.log("polling provider", { taskId: "t1" })
      return "done"
    })
    await engine.run("job", {}, "1")

    const logs = await engine.store.getLogs(engine.instanceId("1"))
    expect(logs[0]?.message).toBe("polling provider")
    expect(logs[0]?.meta).toEqual({ taskId: "t1" })
    expect(engine.jobLogs.some((line) => line.includes("polling provider"))).toBe(true)
  })
})

/** Wrap a store in a Proxy that records which methods were invoked. */
function recordingStore(inner: StateStore, calls: Set<string>): StateStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          calls.add(String(prop))
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return value
    },
  }) as StateStore
}
