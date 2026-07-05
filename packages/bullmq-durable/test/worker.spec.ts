import { DelayedError, UnrecoverableError } from "bullmq"
import { describe, expect, it } from "vitest"
import type { DurableContext, DurableJob, StateStore } from "../src/index"
import {
  DurableCancelledJobError,
  DurableTerminalJobError,
  MemoryStateStore,
  parseLogLine,
} from "../src/index"
import { resolveDurableProcessor, runOutcomeToReturn } from "../src/worker"
import { TestEngine } from "./helpers/engine"

describe("runOutcomeToReturn", () => {
  const id = "q:1"

  it("returns the output for completed runs", () => {
    expect(runOutcomeToReturn({ type: "completed", output: 42 }, id)).toBe(42)
  })

  it("throws DelayedError for suspended runs (job already parked)", () => {
    expect(() => runOutcomeToReturn({ type: "suspended" }, id)).toThrow(DelayedError)
  })

  it("rethrows the original error for retriable runs (BullMQ owns the retry)", () => {
    const error = new Error("transient")
    expect(() => runOutcomeToReturn({ type: "retriable", error }, id)).toThrow(error)
  })

  it("throws DurableTerminalJobError (an UnrecoverableError) for terminal failures", () => {
    const error = new Error("boom")
    try {
      runOutcomeToReturn({ type: "failed", error }, id)
      expect.unreachable()
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(DurableTerminalJobError)
      expect(thrown).toBeInstanceOf(UnrecoverableError)
      expect((thrown as DurableTerminalJobError).cause).toBe(error)
    }
  })

  it("throws DurableCancelledJobError for cancelled runs", () => {
    try {
      runOutcomeToReturn({ type: "cancelled" }, id)
      expect.unreachable()
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(DurableCancelledJobError)
      expect(thrown).toBeInstanceOf(UnrecoverableError)
      expect((thrown as DurableCancelledJobError).instanceId).toBe(id)
    }
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
  it("parks the job briefly when another worker holds the instance lock", async () => {
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
    expect(outcome.type).toBe("suspended")
    expect(ran).toEqual([])
    // The job re-delivers itself shortly (moveToDelayed with a small delay).
    expect(engine.pendingCount).toBe(1)
    expect(engine.peekPending()[0]!.delayMs).toBeLessThanOrEqual(5_000)
  })

  it("releases the lock after a tick finishes", async () => {
    const engine = new TestEngine(async () => "done")
    await engine.run("job", {}, "1")
    expect(await engine.store.acquireLock(engine.instanceId("1"), "anyone", 1_000)).toBe(true)
  })

  it("releases the lock before parking a yielded run", async () => {
    // Guards the ordering that prevents a zero-delay resume from being blocked
    // by a lock the yielding tick still holds.
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.sleep("wait", "10s")
      return "done"
    })
    const outcome = await engine.start("job", {}, "1")

    expect(outcome.type).toBe("suspended")
    expect(engine.pendingCount).toBe(1) // the run's own job is parked
    // ...and the lock is already free, so the re-delivery can acquire it.
    expect(await engine.store.acquireLock(engine.instanceId("1"), "next", 1_000)).toBe(true)
  })

  it("replays the outcome idempotently for a stray re-delivery of a completed run", async () => {
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

  it("replays the stored failure for a manual retry of a terminally-failed run", async () => {
    const engine = new TestEngine(async () => {
      throw new Error("original failure")
    })
    const { outcome } = await engine.run("job", {}, "1")
    expect(outcome.type).toBe("failed")

    // A manual `job.retry()` re-delivers the same job: no business re-run, the
    // stored error replays and the job lands back in failed.
    const retried = await engine.start("job", {}, "1")
    expect(retried.type).toBe("failed")
    expect((retried as { error: Error }).error.message).toBe("original failure")
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

describe("two-budget retries (§step vs §job)", () => {
  it("lets BullMQ attempts drive non-step errors while attempts remain", async () => {
    let calls = 0
    const engine = new TestEngine(
      async () => {
        calls += 1
        if (calls < 3) throw new Error(`transient ${calls}`)
        return "recovered"
      },
      { attempts: 3 },
    )

    const first = await engine.start("job", {}, "1")
    expect(first.type).toBe("retriable")
    // Dashboards must not see a stale "running" while BullMQ waits out backoff.
    expect((await engine.store.getInstance(engine.instanceId("1")))?.status).toBe("yielded")

    const { last } = await engine.drain()
    expect(last).toEqual({ type: "completed", output: "recovered" })
    expect(calls).toBe(3)
    expect(engine.job("1")?.attemptsMade).toBe(2) // two real failures
  })

  it("settles terminally on the last job attempt", async () => {
    const engine = new TestEngine(
      async () => {
        throw new Error("always")
      },
      { attempts: 2 },
    )
    const first = await engine.start("job", {}, "1")
    expect(first.type).toBe("retriable")

    const { last } = await engine.drain()
    expect(last?.type).toBe("failed")
    expect((await engine.store.getInstance(engine.instanceId("1")))?.status).toBe("failed")
  })

  it("step-budget exhaustion settles immediately without burning job attempts", async () => {
    let stepRuns = 0
    const engine = new TestEngine(
      async (_job: DurableJob, ctx: DurableContext) => {
        await ctx.step("flaky", { retry: { attempts: 2 } }, async () => {
          stepRuns += 1
          throw new Error("step boom")
        })
        return "unreachable"
      },
      { attempts: 5 },
    )

    const { outcome, instance } = await engine.run("job", {}, "1")
    expect(outcome.type).toBe("failed")
    expect(stepRuns).toBe(2) // the STEP budget governed the retries
    expect(instance?.status).toBe("failed")
    expect(instance?.failedStep).toBe("flaky")
    // The job-level budget was never consumed: the failure is checkpointed and
    // a re-delivery would only replay it.
    expect(engine.job("1")?.attemptsMade).toBe(0)
  })

  it("a caught-and-recovered step failure does not drag a later transient error terminal", async () => {
    let transientThrown = 0
    const engine = new TestEngine(
      async (_job: DurableJob, ctx: DurableContext) => {
        // The step fails terminally, but user code treats it as optional.
        const enrichment = await ctx
          .step("optional-enrichment", async () => {
            throw new Error("enrichment provider down")
          })
          .catch(() => null)
        // A later, UNRELATED transient failure must ride the JOB retry budget —
        // classification is by error identity, not "a step failed earlier".
        if (transientThrown === 0) {
          transientThrown += 1
          throw new Error("transient network blip")
        }
        return { enrichment }
      },
      { attempts: 3 },
    )

    const first = await engine.start("job", {}, "1")
    expect(first.type).toBe("retriable") // NOT terminal

    const { last } = await engine.drain()
    expect(last).toEqual({ type: "completed", output: { enrichment: null } })
  })

  it("treats a user-thrown UnrecoverableError as terminal despite remaining attempts", async () => {
    let calls = 0
    const engine = new TestEngine(
      async () => {
        calls += 1
        throw new UnrecoverableError("do not retry")
      },
      { attempts: 5 },
    )
    const { outcome } = await engine.run("job", {}, "1")
    expect(outcome.type).toBe("failed")
    expect(calls).toBe(1)
    expect((await engine.store.getInstance(engine.instanceId("1")))?.status).toBe("failed")
  })

  it("defaults to settling on the first unhandled error when attempts is unset", async () => {
    const engine = new TestEngine(async () => {
      throw new Error("boom")
    })
    const first = await engine.start("job", {}, "1")
    expect(first.type).toBe("failed")
  })
})

describe("stall settlement (mode: settle)", () => {
  it("runs compensation for completed steps without executing new side effects", async () => {
    const rolledBack: string[] = []
    let bRuns = 0
    const processor = async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step(
        "a",
        { onRollback: () => void rolledBack.push("a") },
        async () => "a-result",
      )
      await ctx.step("b", async () => {
        bRuns += 1
        return await new Promise(() => undefined) // hangs; the process "dies" here
      })
      return "done"
    }

    const engine = new TestEngine(processor)
    // First delivery crashes mid-step-b (simulated: partial run, no finalise).
    await engine.simulateCrash("job", {}, "1", async (job, ctx) => {
      void processor(job, ctx)
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    bRuns = 0 // only the settlement behaviour matters below

    const outcome = await engine.settle("1", new Error("job stalled more than allowable limit"))

    expect(outcome.type).toBe("failed")
    expect(bRuns).toBe(0) // replay-only: the incomplete step never re-executed
    expect(rolledBack).toEqual(["a"])
    const instance = await engine.store.getInstance(engine.instanceId("1"))
    expect(instance?.status).toBe("failed")
    expect(instance?.compensation?.rolledBack).toEqual(["a"])
  })

  it("no-ops when the instance already settled (in-processor path won)", async () => {
    const engine = new TestEngine(async () => {
      throw new Error("boom")
    })
    await engine.run("job", {}, "1") // settled terminally in-processor
    const outcome = await engine.settle("1", new Error("late failed event"))
    expect(outcome.type).toBe("failed") // replayed, not re-settled
    const instance = await engine.store.getInstance(engine.instanceId("1"))
    expect(instance?.error?.message).toBe("boom") // original error kept
  })
})

describe("ctx.log", () => {
  it("writes structured, attributed JSON lines to the job log", async () => {
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.log("outside steps")
      await ctx.step("charge", async () => {
        await ctx.log("inside step", { orderId: "o_1" })
        return 1
      })
      return "done"
    })
    await engine.run("job", {}, "1")

    const entries = engine.jobLogs.map(parseLogLine)
    const outside = entries.find((e) => e.message === "outside steps")
    expect(outside?.kind).toBe("log")
    expect(outside?.runCount).toBe(1)
    expect(outside?.step).toBeUndefined()

    const inside = entries.find((e) => e.message === "inside step")
    expect(inside?.kind).toBe("log")
    expect(inside?.step).toBe("charge")
    expect(inside?.stepAttempt).toBe(1)
    expect(inside?.meta).toEqual({ orderId: "o_1" })
  })

  it("auto-logs step retry events on genuine failures", async () => {
    let calls = 0
    const engine = new TestEngine(async (_job: DurableJob, ctx: DurableContext) => {
      await ctx.step("flaky", { retry: { attempts: 2 } }, async () => {
        calls += 1
        if (calls === 1) throw new Error("first try fails")
        return "ok"
      })
      return "done"
    })
    await engine.run("job", {}, "1")

    const events = engine.jobLogs.map(parseLogLine).filter((e) => e.kind === "event")
    const retry = events.find((e) => e.event === "step_retry")
    expect(retry?.step).toBe("flaky")
    expect(retry?.err?.message).toBe("first try fails")
    expect(retry?.retryInMs).toBeTypeOf("number")
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
    expect(calls.has("beginStep")).toBe(true)
    expect(calls.has("completeInstance")).toBe(true)
    expect(calls.has("acquireLock")).toBe(true)
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
