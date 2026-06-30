import { describe, expect, it } from "vitest"
import type { DurableContext, DurableFailureInfo, DurableJob } from "../src/index"
import { TestEngine } from "./helpers/engine"

describe("per-step compensation (onRollback)", () => {
  it("runs compensations in reverse order, only for completed steps", async () => {
    const order: string[] = []
    const engine = new TestEngine({
      job: {
        run: async (_job: DurableJob, ctx: DurableContext) => {
          await ctx.step("a", { onRollback: () => void order.push("undo-a") }, async () => "A")
          await ctx.step("b", { onRollback: () => void order.push("undo-b") }, async () => "B")
          // c registers a rollback but FAILS, so its rollback must NOT run.
          await ctx.step("c", { onRollback: () => void order.push("undo-c") }, async () => {
            throw new Error("boom")
          })
          await ctx.step("d", { onRollback: () => void order.push("undo-d") }, async () => "D")
        },
      },
    })

    const { outcome, instance } = await engine.run("job", {}, "1")

    expect(outcome.type).toBe("failed")
    expect(instance?.status).toBe("failed")
    // reverse of completed steps; c (failed) and d (never ran) are excluded.
    expect(order).toEqual(["undo-b", "undo-a"])
  })

  it("compensation receives the step output and the triggering error", async () => {
    let seen: { output: unknown; error: unknown } | undefined
    const engine = new TestEngine({
      job: {
        run: async (_job: DurableJob, ctx: DurableContext) => {
          await ctx.step("reserve", { onRollback: (rb) => void (seen = rb) }, async () => ({
            chargeId: "ch_1",
          }))
          await ctx.step("explode", async () => {
            throw new Error("downstream failed")
          })
        },
      },
    })

    await engine.run("job", {}, "1")

    expect(seen?.output).toEqual({ chargeId: "ch_1" })
    expect((seen?.error as Error).message).toBe("downstream failed")
  })

  it("a job with no hooks fails exactly like 0.1.x (never enters compensating)", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("a", async () => "A")
      await ctx.step("b", async () => {
        throw new Error("boom")
      })
    })

    const { outcome, instance } = await engine.run("job", {}, "1")

    expect(outcome.type).toBe("failed")
    expect(instance?.status).toBe("failed")
    expect(instance?.compensation).toBeUndefined()
    const steps = await engine.store.getSteps(engine.instanceId("1"))
    expect(steps.every((s) => (s.phase ?? "main") === "main")).toBe(true)
  })
})

describe("rollback failure → compensation_failed", () => {
  it("a permanently-failing compensation does not block the others, and lands compensation_failed", async () => {
    const order: string[] = []
    const engine = new TestEngine(
      {
        job: {
          run: async (_job: DurableJob, ctx: DurableContext) => {
            await ctx.step("a", { onRollback: () => void order.push("undo-a") }, async () => "A")
            await ctx.step(
              "b",
              {
                onRollback: () => {
                  order.push("undo-b")
                  throw new Error("refund provider down")
                },
              },
              async () => "B",
            )
            await ctx.step("c", async () => {
              throw new Error("boom")
            })
          },
        },
      },
      // Make compensation failure immediate (no retry/yield) for the test.
      { defaultRollbackRetry: { attempts: 1 } },
    )

    const { outcome, instance } = await engine.run("job", {}, "1")

    expect(outcome.type).toBe("failed")
    expect((outcome as { compensationFailed?: boolean }).compensationFailed).toBe(true)
    expect(instance?.status).toBe("compensation_failed")
    // b failed but a still ran (independent undos).
    expect(order).toEqual(["undo-b", "undo-a"])
    expect(instance?.compensation?.rolledBack).toEqual(["a"])
    expect(instance?.compensation?.failed.map((f) => f.key)).toEqual(["b"])
  })
})

describe("onFailure terminal handler", () => {
  it("runs after compensation with structured failure info, under the __failure__ namespace", async () => {
    let info: DurableFailureInfo | undefined
    const engine = new TestEngine({
      job: {
        run: async (_job: DurableJob, ctx: DurableContext) => {
          await ctx.step("reserve", { onRollback: () => undefined }, async () => "ok")
          await ctx.step("poll", async () => {
            throw new Error("provider 500")
          })
        },
        onFailure: async (_job, ctx, failure) => {
          info = failure
          await ctx.step("notify", async () => "notified")
        },
      },
    })

    const { instance } = await engine.run("job", {}, "1")

    expect(instance?.status).toBe("failed")
    expect(info?.failedStep).toBe("poll")
    expect([...(info?.completed ?? [])]).toEqual(["reserve"])
    expect(info?.compensation.rolledBack).toEqual(["reserve"])

    const steps = await engine.store.getSteps(engine.instanceId("1"))
    const notify = steps.find((s) => s.phase === "failure")
    expect(notify?.key).toBe("notify")
    expect(notify?.status).toBe("completed")
  })

  it("control-flow signals never trigger onFailure (success path)", async () => {
    let called = 0
    const engine = new TestEngine({
      job: {
        run: async (_job: DurableJob, ctx: DurableContext) => {
          await ctx.sleep("wait", "1s")
          return await ctx.step("ok", async () => "done")
        },
        onFailure: async () => void called++,
      },
    })

    const { outcome } = await engine.run("job", {}, "1")
    expect(outcome.type).toBe("completed")
    expect(called).toBe(0)
  })
})

describe("compensation across resume (durable + idempotent)", () => {
  it("a compensation that retries suspends and resumes, without re-running completed work", async () => {
    let aRan = 0
    let bRan = 0
    let cRan = 0
    let undoA = 0
    let undoBCalls = 0
    const order: string[] = []

    const engine = new TestEngine({
      job: {
        run: async (_job: DurableJob, ctx: DurableContext) => {
          await ctx.step(
            "a",
            {
              onRollback: () => {
                undoA++
                order.push("undo-a")
              },
            },
            async () => {
              aRan++
              return "A"
            },
          )
          await ctx.step(
            "b",
            {
              // transient compensation failure, then success, with retry.
              onRollback: {
                handler: () => {
                  undoBCalls++
                  order.push(`undo-b#${undoBCalls}`)
                  if (undoBCalls === 1) throw new Error("transient")
                },
                retry: { attempts: 2, delay: 0 },
              },
            },
            async () => {
              bRan++
              return "B"
            },
          )
          await ctx.step("c", async () => {
            cRan++
            throw new Error("boom")
          })
        },
      },
    })

    const { outcome, instance, ticks } = await engine.run("job", {}, "1")

    expect(outcome.type).toBe("failed")
    expect((outcome as { compensationFailed?: boolean }).compensationFailed).toBeUndefined()
    expect(instance?.status).toBe("failed")
    // forward steps ran exactly once (cache hits on the compensation resume).
    expect(aRan).toBe(1)
    expect(bRan).toBe(1)
    // the failed step's body is NOT re-run on the compensation resume (replay-throw).
    expect(cRan).toBe(1)
    // compensation took at least one resume to converge.
    expect(ticks).toBeGreaterThanOrEqual(1)
    // b's compensation ran twice (transient → retry), a's once.
    expect(undoBCalls).toBe(2)
    expect(undoA).toBe(1)
    // final order: b retried then succeeded, then a.
    expect(order).toEqual(["undo-b#1", "undo-b#2", "undo-a"])
    expect(instance?.compensation?.rolledBack).toEqual(["b", "a"])
    expect(instance?.compensation?.failed).toEqual([])
  })
})

describe("cancellation bypasses settlement", () => {
  it("a cancelled instance runs neither compensation nor onFailure", async () => {
    const order: string[] = []
    let onFailureCalled = 0
    const engine = new TestEngine({
      job: {
        run: async (job: DurableJob, ctx: DurableContext) => {
          await ctx.step("a", { onRollback: () => void order.push("undo-a") }, async () => "A")
          // Cancel the instance mid-flight, then the next step observes it.
          await engine.store.cancelInstance(job.durableId)
          await ctx.step("b", async () => "B")
        },
        onFailure: async () => void onFailureCalled++,
      },
    })

    const { outcome, instance } = await engine.run("job", {}, "1")

    expect(outcome.type).toBe("cancelled")
    expect(instance?.status).toBe("cancelled")
    expect(order).toEqual([])
    expect(onFailureCalled).toBe(0)
  })
})
