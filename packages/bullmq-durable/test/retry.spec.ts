import { describe, expect, it } from "vitest"
import type { DurableContext, DurableJob } from "../src/index"
import { computeBackoff, DEFAULT_MAX_BACKOFF_MS, resolveRetry } from "../src/utils/retry"
import { TestEngine } from "./helpers/engine"

describe("retry policy", () => {
  it("resolves defaults and merges step over worker options", () => {
    expect(resolveRetry()).toEqual({
      attempts: 1,
      type: "fixed",
      delayMs: 0,
      jitter: 0,
      maxDelayMs: undefined,
    })

    const merged = resolveRetry(
      { attempts: 5 },
      { attempts: 2, backoff: { type: "exponential", delay: "10s" } },
    )
    expect(merged).toEqual({
      attempts: 5,
      type: "exponential",
      delayMs: 10_000,
      jitter: 0,
      maxDelayMs: undefined,
    })
  })

  it("accepts the BullMQ-shaped backoff forms", () => {
    // A bare number/duration is a fixed delay, exactly like BullMQ's `backoff: 5000`.
    expect(resolveRetry({ backoff: 5000 })).toMatchObject({ type: "fixed", delayMs: 5000 })
    expect(resolveRetry({ backoff: "5s" })).toMatchObject({ type: "fixed", delayMs: 5000 })
    // The object form mirrors BullMQ's BackoffOptions (plus maxDelay).
    expect(
      resolveRetry({ backoff: { type: "exponential", delay: 200, jitter: 0.5, maxDelay: "1m" } }),
    ).toMatchObject({ type: "exponential", delayMs: 200, jitter: 0.5, maxDelayMs: 60_000 })
  })

  it("still accepts the deprecated 0.1.x flat shape, unchanged in behaviour", () => {
    const legacy = resolveRetry({
      attempts: 3,
      backoff: "exponential",
      delay: "10s",
      maxDelay: "5m",
    })
    expect(legacy).toEqual({
      attempts: 3,
      type: "exponential",
      delayMs: 10_000,
      jitter: 0,
      maxDelayMs: 300_000,
    })
  })

  it("computes fixed and exponential backoff", () => {
    const fixed = resolveRetry({ attempts: 5, backoff: "10s" })
    expect(computeBackoff(fixed, 1)).toBe(10_000)
    expect(computeBackoff(fixed, 3)).toBe(10_000)

    const exp = resolveRetry({ attempts: 5, backoff: { type: "exponential", delay: "1s" } })
    expect(computeBackoff(exp, 1)).toBe(1_000)
    expect(computeBackoff(exp, 2)).toBe(2_000)
    expect(computeBackoff(exp, 3)).toBe(4_000)

    const capped = resolveRetry({
      attempts: 5,
      backoff: { type: "exponential", delay: "1s", maxDelay: "3s" },
    })
    expect(computeBackoff(capped, 3)).toBe(3_000) // 4s capped to 3s
  })

  it("spreads jittered delays over [base*(1-jitter), base), like BullMQ", () => {
    const jittered = resolveRetry({ backoff: { type: "fixed", delay: 1000, jitter: 0.5 } })
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoff(jittered, 1)
      expect(delay).toBeGreaterThanOrEqual(500)
      expect(delay).toBeLessThan(1000)
    }
    // Jitter never exceeds maxDelay: the cap applies BEFORE randomisation.
    const cappedJitter = resolveRetry({
      backoff: { type: "exponential", delay: "1s", jitter: 0.5, maxDelay: "2s" },
    })
    for (let i = 0; i < 50; i++) {
      expect(computeBackoff(cappedJitter, 5)).toBeLessThanOrEqual(2_000)
    }
  })

  it("caps exponential backoff at a default ceiling when no maxDelay is set", () => {
    const exp = resolveRetry({ attempts: 100, backoff: { type: "exponential", delay: "1s" } })
    // Without a cap, 1s * 2**79 would overflow toward Infinity.
    const delay = computeBackoff(exp, 80)
    expect(Number.isFinite(delay)).toBe(true)
    expect(delay).toBe(DEFAULT_MAX_BACKOFF_MS)
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

  it("polls indefinitely by default (no retry config) until it stops throwing", async () => {
    let polls = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      return ctx.step("poll", async () => {
        polls++
        if (polls < 4) throw ctx.retryLater("pending")
        return "ready"
      })
    })

    // With no explicit `attempts`, retryLater must not exhaust on the first call.
    const { outcome, ticks } = await engine.run("job", {}, "1")
    expect(polls).toBe(4)
    expect(ticks).toBe(3)
    expect(outcome).toEqual({ type: "completed", output: "ready" })
  })

  it("caps polling when attempts is explicitly configured", async () => {
    let polls = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("poll", { retry: { attempts: 3, delay: "1s" } }, async () => {
        polls++
        throw ctx.retryLater("never ready")
      })
      return "done"
    })

    const { outcome } = await engine.run("job", {}, "1")
    expect(polls).toBe(3) // bounded by the explicit attempts
    expect(outcome.type).toBe("failed")
  })

  it("treats a numeric-looking single argument as a reason, not a delay", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("poll", { retry: { attempts: 5, delay: "9s" } }, async () => {
        throw ctx.retryLater("30") // "30" is a reason; the delay comes from retry config
      })
      return "done"
    })
    await engine.start("job", {}, "1")
    // "30" was NOT parsed as a 30ms delay — the configured 9s delay applied.
    expect(engine.peekPending()[0]?.delayMs).toBe(9_000)
  })

  it("treats a unit-qualified single argument as a delay", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("poll", { retry: { attempts: 5, delay: "9s" } }, async () => {
        throw ctx.retryLater("10s")
      })
      return "done"
    })
    await engine.start("job", {}, "1")
    expect(engine.peekPending()[0]?.delayMs).toBe(10_000)
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
