import { describe, expect, it } from "vitest"
import type { DurableContext, DurableJob } from "../src/index"
import { computeBackoff, resolveRetry } from "../src/utils/retry"
import { TestEngine } from "./helpers/engine"

describe("retry policy", () => {
  it("resolves defaults and merges step over worker options", () => {
    expect(resolveRetry()).toEqual({
      attempts: 1,
      backoff: "fixed",
      delayMs: 0,
      maxDelayMs: undefined,
    })

    const merged = resolveRetry(
      { attempts: 5 },
      { attempts: 2, delay: "10s", backoff: "exponential" },
    )
    expect(merged).toEqual({
      attempts: 5,
      backoff: "exponential",
      delayMs: 10_000,
      maxDelayMs: undefined,
    })
  })

  it("computes fixed and exponential backoff", () => {
    const fixed = resolveRetry({ attempts: 5, delay: "10s", backoff: "fixed" })
    expect(computeBackoff(fixed, 1)).toBe(10_000)
    expect(computeBackoff(fixed, 3)).toBe(10_000)

    const exp = resolveRetry({ attempts: 5, delay: "1s", backoff: "exponential" })
    expect(computeBackoff(exp, 1)).toBe(1_000)
    expect(computeBackoff(exp, 2)).toBe(2_000)
    expect(computeBackoff(exp, 3)).toBe(4_000)

    const capped = resolveRetry({
      attempts: 5,
      delay: "1s",
      backoff: "exponential",
      maxDelay: "3s",
    })
    expect(computeBackoff(capped, 3)).toBe(3_000) // 4s capped to 3s
  })
})

describe("ctx.step retry", () => {
  it("retries a failing step and eventually succeeds", async () => {
    let attempts = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      const value = await ctx.step("flaky", { retry: { attempts: 3, delay: "1s" } }, async () => {
        attempts++
        if (attempts < 3) throw new Error("transient")
        return "ok"
      })
      return value
    })

    const { outcome, instance, ticks } = await engine.run("job", {}, "1")
    expect(attempts).toBe(3)
    expect(ticks).toBe(2) // resumed twice
    expect(outcome).toEqual({ type: "completed", output: "ok" })
    expect(instance?.status).toBe("completed")
  })

  it("fails the instance once retries are exhausted", async () => {
    let attempts = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("always", { retry: { attempts: 2, delay: "1s" } }, async () => {
        attempts++
        throw new Error("permanent")
      })
      return "done"
    })

    const { outcome, instance } = await engine.run("job", {}, "1")
    expect(attempts).toBe(2)
    expect(outcome.type).toBe("failed")
    expect(instance?.status).toBe("failed")
    expect(instance?.error?.message).toContain("permanent")
  })

  it("schedules the first retry using the configured delay", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("flaky", { retry: { attempts: 3, delay: "15s" } }, async () => {
        throw new Error("transient")
      })
      return "done"
    })
    await engine.start("job", {}, "1")
    expect(engine.peekPending()[0]?.delayMs).toBe(15_000)
  })

  it("uses worker-level defaultStepOptions when a step omits retry", async () => {
    let attempts = 0
    const engine = new TestEngine(
      async (_job: DurableJob, ctx: DurableContext) => {
        await ctx.step("flaky", async () => {
          attempts++
          if (attempts < 2) throw new Error("transient")
          return "ok"
        })
        return "done"
      },
      { defaultStepOptions: { retry: { attempts: 2, delay: "1s" } } },
    )

    const { instance } = await engine.run("job", {}, "1")
    expect(attempts).toBe(2)
    expect(instance?.status).toBe("completed")
  })
})

describe("ctx.retryLater", () => {
  it("re-runs the step later until a condition is met", async () => {
    let polls = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      const result = await ctx.step("poll", { retry: { attempts: 10, delay: "5s" } }, async () => {
        polls++
        if (polls < 3) throw ctx.retryLater("still pending")
        return { status: "done" }
      })
      return result
    })

    const { outcome, instance, ticks } = await engine.run("job", {}, "1")
    expect(polls).toBe(3)
    expect(ticks).toBe(2)
    expect(outcome.type).toBe("completed")
    expect(instance?.output).toEqual({ status: "done" })
  })

  it("honours an explicit retryLater delay", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("poll", { retry: { attempts: 5, delay: "5s" } }, async () => {
        throw ctx.retryLater("20s", "provider pending")
      })
      return "done"
    })
    await engine.start("job", {}, "1")
    expect(engine.peekPending()[0]?.delayMs).toBe(20_000)
    expect(engine.peekPending()[0]?.reason).toContain("provider pending")
  })

  it("does not record an error on the step while retrying", async () => {
    let polls = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("poll", { retry: { attempts: 5, delay: "1s" } }, async () => {
        polls++
        if (polls < 2) throw ctx.retryLater("pending")
        return "ok"
      })
      return "done"
    })
    await engine.start("job", {}, "1")
    const step = await engine.store.getStep(engine.instanceId("1"), "poll")
    expect(step?.error).toBeUndefined()
    expect(step?.nextRunAt).toBeTypeOf("number")
  })
})

describe("ctx.nonRetryable", () => {
  it("fails the instance immediately, ignoring remaining attempts", async () => {
    let attempts = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("guard", { retry: { attempts: 5, delay: "1s" } }, async () => {
        attempts++
        throw ctx.nonRetryable("invalid input")
      })
      return "done"
    })

    const { outcome, instance } = await engine.run("job", {}, "1")
    expect(attempts).toBe(1) // no retry
    expect(engine.pendingCount).toBe(0) // no resume scheduled
    expect(outcome.type).toBe("failed")
    expect(instance?.status).toBe("failed")
    expect(instance?.error?.message).toContain("invalid input")
  })
})
