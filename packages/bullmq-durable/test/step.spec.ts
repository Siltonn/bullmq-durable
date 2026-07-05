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

  it("returns the checkpointed (serialized) shape on the first run, matching replay", async () => {
    let firstRunValue: { when: unknown; tag?: unknown } | undefined
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      firstRunValue = await ctx.step("with-date", async () => ({
        when: new Date(0),
        tag: undefined,
      }))
      return "done"
    })

    await engine.run("job", {}, "1")

    // The value handed back on the first tick is already the post-round-trip
    // shape a replay would yield: the Date is an ISO string and the `undefined`
    // field is gone. Returning the live object here would let code work the
    // first time and throw (e.g. `.getTime()` on a string) after a resume.
    expect(typeof firstRunValue?.when).toBe("string")
    expect(firstRunValue && "tag" in firstRunValue).toBe(false)

    const step = await engine.store.getStep(engine.instanceId("1"), "with-date")
    expect(step?.result).toEqual(firstRunValue)
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

describe("concurrent steps (Promise.all)", () => {
  it("waits for detached siblings to settle before the tick finalises", async () => {
    const done: string[] = []
    let resolveSlow: (() => void) | undefined
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await Promise.all([
        // Yields immediately (sleep) — unwinds Promise.all on the first tick.
        ctx.sleep("wait", "10s"),
        // Keeps running detached until we let it finish.
        ctx.step("slow", async () => {
          await new Promise<void>((resolve) => {
            resolveSlow = () => resolve()
          })
          done.push("slow")
          return "slow-done"
        }),
      ])
      return "done"
    })

    const first = engine.start("job", {}, "1")
    // Let the tick reach the yield, then release the sibling: the tick must not
    // finalise (suspend) until the sibling settled and its write landed.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resolveSlow).toBeDefined()
    resolveSlow!()
    const outcome = await first

    expect(outcome.type).toBe("suspended")
    expect(done).toEqual(["slow"]) // sibling finished BEFORE the tick returned
    const slow = await engine.store.getStep(engine.instanceId("1"), "slow")
    expect(slow?.status).toBe("completed") // its checkpoint landed inside the tick

    const { last } = await engine.drain()
    expect(last?.type).toBe("completed")
  })

  it("attributes ctx.log to the right step across concurrent steps", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await Promise.all([
        ctx.step("alpha", async () => {
          await ctx.log("from alpha")
          return 1
        }),
        ctx.step("beta", async () => {
          await ctx.log("from beta")
          return 2
        }),
      ])
      return "done"
    })
    await engine.run("job", {}, "1")

    const { parseLogLine } = await import("../src/utils/log")
    const entries = engine.jobLogs.map(parseLogLine)
    expect(entries.find((e) => e.message === "from alpha")?.step).toBe("alpha")
    expect(entries.find((e) => e.message === "from beta")?.step).toBe("beta")
  })

  it("honours a persisted retry backoff on early re-delivery (no premature attempt)", async () => {
    let attempts = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("flaky", { retry: { attempts: 3, backoff: "60s" } }, async () => {
        attempts++
        if (attempts < 2) throw new Error("transient")
        return "ok"
      })
      return "done"
    })

    await engine.start("job", {}, "1") // attempt 1 fails, backoff 60s persisted
    expect(attempts).toBe(1)

    // Early re-delivery (stall takeover / promote) BEFORE the backoff elapsed:
    // the attempt must NOT run early — the run re-parks for the remainder.
    const early = await engine.deliverNow("1")
    expect(early.type).toBe("suspended")
    expect(attempts).toBe(1)

    const { last } = await engine.drain() // time passes to nextRunAt
    expect(attempts).toBe(2)
    expect(last?.type).toBe("completed")
  })
})

