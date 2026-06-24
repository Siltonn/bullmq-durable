import { describe, expect, it } from "vitest"
import type { DurableContext, DurableJob } from "../src/index"
import { TestEngine } from "./helpers/engine"

describe("ctx.sleep", () => {
  it("yields, schedules a delayed resume, then continues after replay", async () => {
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
    expect(first.type).toBe("yielded")
    expect(engine.pendingCount).toBe(1)
    expect(engine.peekPending()[0]?.delayMs).toBe(30_000)
    expect(order).toEqual(["before"])

    await engine.drain()

    // "before" is a cache hit on resume; only "after" runs the second time.
    expect(order).toEqual(["before", "after"])
    const instance = await engine.store.getInstance(engine.instanceId("1"))
    expect(instance?.status).toBe("completed")
  })

  it("records the sleep as a completed step with a resumeAt", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleep("nap", "10s")
      return "done"
    })
    await engine.run("job", {}, "1")

    const step = await engine.store.getStep(engine.instanceId("1"), "nap")
    expect(step?.type).toBe("sleep")
    expect(step?.status).toBe("completed")
    expect((step?.result as { resumeAt: number }).resumeAt).toBeTypeOf("number")
  })

  it("sleepUntil yields for a future time", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleepUntil("until", Date.now() + 60_000)
      return "woke"
    })
    const first = await engine.start("job", {}, "1")
    expect(first.type).toBe("yielded")
    const delay = engine.peekPending()[0]?.delayMs ?? 0
    expect(delay).toBeGreaterThan(50_000)

    const { instance } = await finishDrain(engine, "1")
    expect(instance?.status).toBe("completed")
  })

  it("does not yield for a non-positive delay (continues inline)", async () => {
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
