import { describe, expect, it } from "vitest"
import type { DurableContext, DurableJob } from "../src/index"
import { TestEngine } from "./helpers/engine"

describe("ctx.step", () => {
  it("runs a step once and completes the instance with its return value", async () => {
    let calls = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      const value = await ctx.step("a", async () => {
        calls++
        return { id: "abc" }
      })
      return value
    })

    const { outcome, instance } = await engine.run("job", {}, "1")

    expect(calls).toBe(1)
    expect(outcome).toEqual({ type: "completed", output: { id: "abc" } })
    expect(instance?.status).toBe("completed")
    expect(instance?.output).toEqual({ id: "abc" })
  })

  it("does not rerun completed steps after a crash (replays from checkpoint)", async () => {
    let count = 0
    const processor = async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("a", async () => {
        count++
        return "a"
      })
      await ctx.step("b", async () => "b")
      return "done"
    }
    const engine = new TestEngine(processor)

    // First tick completes step "a", then the process dies before finishing.
    await engine.simulateCrash("job", {}, "1", async (_job, ctx) => {
      await ctx.step("a", async () => {
        count++
        return "a"
      })
      throw new Error("crash")
    })

    // Resume: step "a" must be a cache hit.
    const { outcome } = await engine.run("job", {}, "1")

    expect(count).toBe(1)
    expect(outcome.type).toBe("completed")
  })

  it("caches and replays the exact step result", async () => {
    const seen: unknown[] = []
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      const a = await ctx.step("a", async () => ({ n: 1 }))
      seen.push(a)
      return a
    })

    await engine.simulateCrash("job", {}, "1", async (_job, ctx) => {
      await ctx.step("a", async () => ({ n: 1 }))
      throw new Error("crash")
    })
    await engine.run("job", {}, "1")

    // The replayed value comes from the store, not a fresh execution.
    expect(seen).toEqual([{ n: 1 }])
  })

  it("supports the (key, options, fn) overload", async () => {
    let calls = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      return ctx.step("with-opts", { retry: { attempts: 1 } }, async () => {
        calls++
        return "ok"
      })
    })
    const { outcome } = await engine.run("job", {}, "1")
    expect(calls).toBe(1)
    expect(outcome).toEqual({ type: "completed", output: "ok" })
  })

  it("handles steps that resolve to undefined", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      const value = await ctx.step("noop", async () => undefined)
      expect(value).toBeUndefined()
      return "done"
    })
    const { outcome } = await engine.run("job", {}, "1")
    expect(outcome.type).toBe("completed")
  })

  it("exposes a deterministic stepId for idempotency keys", async () => {
    let stepId = ""
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      stepId = ctx.stepId("deduct-credits")
      return null
    })
    await engine.run("job", {}, "42")
    expect(stepId).toBe("test:42:deduct-credits")
  })

  it("records each step in the store", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("first", async () => 1)
      await ctx.step("second", async () => 2)
      return null
    })
    await engine.run("job", {}, "1")
    const steps = await engine.store.getSteps(engine.instanceId("1"))
    expect(steps.map((s) => s.key).sort()).toEqual(["first", "second"])
    expect(steps.every((s) => s.status === "completed")).toBe(true)
  })
})
