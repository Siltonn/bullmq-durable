import { describe, expect, it } from "vitest"
import type { DurableContext, DurableJob } from "../src/index"
import { TestEngine } from "./helpers/engine"

describe("ctx.sleep", () => {
  it("parks the job for the duration, then continues after re-delivery", async () => {
    const order: string[] = []
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("before", async () => {
        order.push("before")
        return 1
      })
      await ctx.sleep("wait", "30s")
      await ctx.step("after", async () => {
        order.push("after")
        return 2
      })
      return "done"
    })

    const first = await engine.start("job", {}, "1")
    expect(first.type).toBe("suspended") // the run's own job moveToDelayed'd
    expect(engine.pendingCount).toBe(1)
    expect(engine.peekPending()[0]?.delayMs).toBe(30_000)
    expect(order).toEqual(["before"])

    await engine.drain()

    // "before" is a cache hit on resume; only "after" runs the second time.
    expect(order).toEqual(["before", "after"])
    const instance = await engine.store.getInstance(engine.instanceId("1"))
    expect(instance?.status).toBe("completed")
  })

  it("persists the sleep as running+nextRunAt, completed only once elapsed", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleep("nap", "10s")
      return "done"
    })

    await engine.start("job", {}, "1")
    // Mid-sleep: the step is NOT completed — the fix for the 0.1.x crash window
    // where a "completed" sleep record let a re-delivery skip the wait.
    let step = await engine.store.getStep(engine.instanceId("1"), "nap")
    expect(step?.type).toBe("sleep")
    expect(step?.status).toBe("running")
    expect(step?.nextRunAt).toBeTypeOf("number")

    await engine.drain()
    step = await engine.store.getStep(engine.instanceId("1"), "nap")
    expect(step?.status).toBe("completed")
  })

  it("re-suspends for the remainder when re-delivered before the wake time", async () => {
    let after = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleep("wait", "60s")
      after += 1
      return "done"
    })

    await engine.start("job", {}, "1")
    // Simulate an early re-delivery (stall takeover / promote) WITHOUT advancing
    // the clock: deliver the same job again right now.
    const early = await engine.deliverNow("1")
    expect(early.type).toBe("suspended") // re-parked, not skipped
    expect(after).toBe(0) // the code after the sleep did NOT run early

    await engine.drain() // now time passes to the wake time
    expect(after).toBe(1)
    expect((await engine.store.getInstance(engine.instanceId("1")))?.status).toBe("completed")
  })

  it("sleepUntil parks the job until a future time", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleepUntil("until", Date.now() + 60_000)
      return "woke"
    })
    const first = await engine.start("job", {}, "1")
    expect(first.type).toBe("suspended")
    const delay = engine.peekPending()[0]?.delayMs ?? 0
    expect(delay).toBeGreaterThan(50_000)

    const { instance } = await finishDrain(engine, "1")
    expect(instance?.status).toBe("completed")
  })

  it("does not suspend for a non-positive delay (continues inline)", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleep("zero", 0)
      await ctx.sleepUntil("past", Date.now() - 5_000)
      return "done"
    })
    const outcome = await engine.start("job", {}, "1")
    expect(outcome).toEqual({ type: "completed", output: "done" })
    expect(engine.pendingCount).toBe(0)
  })
})

async function finishDrain(engine: TestEngine, jobId: string) {
  await engine.drain()
  const instance = await engine.store.getInstance(engine.instanceId(jobId))
  return { instance }
}
