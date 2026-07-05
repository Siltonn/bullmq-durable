/**
 * Per-tick execution runtime.
 *
 * A {@link DurableRuntime} drives exactly one execution tick for one instance:
 * acquire the (internal, fixed-TTL) instance lock, begin the tick, bail out if
 * the instance is already finished, run the user processor against a fresh
 * {@link DurableContextImpl}, then persist the outcome.
 *
 * One run = one BullMQ job. Suspensions (sleep / step backoff / retryLater)
 * become `job.moveToDelayed(due, token)` on that same job; the worker then
 * throws BullMQ's `DelayedError` so the job is left in the delayed set. The
 * worker translates every {@link RunOutcome} into BullMQ semantics — see
 * `runOutcomeToReturn` in worker.ts.
 */

import { randomUUID } from "node:crypto"
import { UnrecoverableError } from "bullmq"
import {
  DurableContextImpl,
  type JobLogSink,
  type PendingResume,
  type RunMode,
  SettleIncompleteError,
} from "./context"
import {
  DurableCancelledError,
  DurableNonRetryableError,
  DurableYieldError,
  isStepFailure,
} from "./errors"
import type { StateStore } from "./store/state-store"
import type {
  CompensationReport,
  DurableContext,
  DurableFailureHandler,
  DurableFailureInfo,
  DurableJob,
  DurableProcessor,
  RetryOptions,
  StepOptions,
} from "./types"
import { deserializeError, serializeError } from "./utils/serialize"

/** The result of a single execution tick, translated to BullMQ by the worker. */
export type RunOutcome =
  /** The run finished — return `output` so the job completes. */
  | { type: "completed"; output: unknown }
  /**
   * The job has been (or must be treated as) parked: a suspension was recorded
   * via `moveToDelayed`, the instance lock was contended, or a fence told us
   * another worker owns the state now. The worker throws `DelayedError` so
   * BullMQ neither completes nor fails the job.
   */
  | { type: "suspended" }
  /**
   * A non-step error with job attempts remaining: rethrow the original error
   * so BullMQ's own `attempts`/`backoff` schedule the re-delivery.
   */
  | { type: "retriable"; error: unknown }
  /**
   * The run is terminally failed (compensation + onFailure already ran, or a
   * stray delivery replayed an already-terminal failure). The worker throws
   * `DurableTerminalJobError` (an `UnrecoverableError`) so BullMQ stops.
   */
  | { type: "failed"; error: unknown }
  /** The run was cancelled — the worker throws `DurableCancelledJobError`. */
  | { type: "cancelled" }

/** Internal pre-outcome: a yield that still needs its `moveToDelayed`. */
type TickResult = RunOutcome | { type: "yield-pending"; resume: PendingResume }

/**
 * Default retry for `onRollback` compensations that don't set their own.
 * Compensations should be tried hard before giving up (a stuck compensation is
 * an operational escalation, not a silent loss).
 */
const DEFAULT_ROLLBACK_RETRY: RetryOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: "1s", maxDelay: "30s" },
}

/**
 * Internal instance-lock TTL. Not user-tunable since 0.2.0: BullMQ's own job
 * lock serialises deliveries, so this lock only fences the zombie window after
 * a stall takeover — 30s (renewed at ~1/3) is comfortably wider than that.
 */
const LOCK_TTL_MS = 30_000

/**
 * How long to park the job when the instance lock is contended (a zombie
 * holder is still finishing). The stale lock expires within {@link LOCK_TTL_MS},
 * so a short re-delivery loop converges quickly.
 */
const LOCK_CONTENTION_RETRY_MS = 5_000

/** Fallback suspension when a yield somehow recorded no resume. */
const DEFAULT_RESUME_DELAY_MS = 1_000

/**
 * The minimal job surface the runtime needs. Structurally satisfied by a real
 * BullMQ job (and by the test engine's fake): suspension, attempt accounting,
 * and the log sink.
 */
export interface DurableRuntimeJob extends JobLogSink {
  attemptsMade?: number
  opts?: { attempts?: number }
  discarded?: boolean
  moveToDelayed?(timestamp: number, token?: string): Promise<void>
}

export interface DurableRuntimeParams {
  instanceId: string
  queueName: string
  jobName: string
  /** The user payload. */
  jobData: unknown
  originalJobId: string
  /** The run's BullMQ job (exposed to the processor; drives suspension/logs). */
  job?: DurableRuntimeJob
  /** BullMQ's worker token for this delivery — fences `moveToDelayed`. */
  token?: string
  store: StateStore
  defaultStepOptions?: StepOptions
  /** Default retry for `onRollback` compensations that don't set their own. */
  defaultRollbackRetry?: RetryOptions
  /** Terminal-failure handler, run after compensation. */
  onFailure?: DurableFailureHandler
  /**
   * `"settle"` runs the post-mortem tick from the worker's `failed` listener:
   * forward phase is replay-only, compensation retries wait in-process, and
   * {@link DurableRuntimeParams.settleError} is the terminal trigger.
   */
  mode?: RunMode
  /** The job's failure reason when `mode === "settle"`. */
  settleError?: unknown
  /** Time source for scheduling decisions (injectable for tests). */
  clock?: () => number
}

export class DurableRuntime {
  private runCount = 1
  private readonly lockToken = randomUUID()
  /** Status the instance had when this tick began (drives §compensating routing). */
  private enteredCompensating = false

  constructor(private readonly params: DurableRuntimeParams) {}

  private get mode(): RunMode {
    return this.params.mode ?? "normal"
  }

  private now(): number {
    return this.params.clock?.() ?? Date.now()
  }

  /** attemptsMade + 1: which BullMQ attempt cycle this delivery belongs to. */
  private get jobAttempt(): number {
    return (this.params.job?.attemptsMade ?? 0) + 1
  }

  /** Build a context bound to this tick. Exposed for white-box testing. */
  createContext(): DurableContext {
    return this.buildContext()
  }

  private buildContext(): DurableContextImpl {
    return new DurableContextImpl({
      instanceId: this.params.instanceId,
      runCount: this.runCount,
      store: this.params.store,
      defaultStepOptions: this.params.defaultStepOptions,
      job: this.params.job,
      jobAttempt: this.jobAttempt,
      mode: this.mode,
      clock: this.params.clock,
    })
  }

  /**
   * Run one execution tick end to end. The instance lock is held only for the
   * locked section; a yielded suspension calls `moveToDelayed` *after* the lock
   * is released, so a zero-delay resume can never be blocked by a lock we still
   * hold. (A crash in that window leaves the job active — BullMQ stall recovery
   * re-delivers it and the replay is idempotent.)
   */
  async run(processor: DurableProcessor): Promise<RunOutcome> {
    const { store, instanceId } = this.params

    const acquired = await store.acquireLock(instanceId, this.lockToken, LOCK_TTL_MS)
    if (!acquired) {
      // Another worker is still advancing this instance (zombie window after a
      // stall takeover). Park the job briefly; the stale lock expires soon.
      return this.suspend(LOCK_CONTENTION_RETRY_MS)
    }

    const stopRenewal = this.startLockRenewal()
    let result: TickResult
    try {
      result = await this.runLocked(processor)
    } finally {
      stopRenewal()
      await store.releaseLock(instanceId, this.lockToken)
    }

    if (result.type === "yield-pending") {
      return this.suspend(result.resume.delayMs)
    }
    return result
  }

  /**
   * Park the run's job for `delayMs` via `moveToDelayed`. Token-fenced: if the
   * fence rejects (a stall takeover re-delivered the job to another worker),
   * we simply hand off — the outcome is "suspended" either way, which makes the
   * bull worker leave the job alone.
   */
  private async suspend(delayMs: number): Promise<RunOutcome> {
    const { job, token } = this.params
    if (job?.moveToDelayed) {
      try {
        await job.moveToDelayed(this.now() + delayMs, token)
      } catch {
        // Stale token — the rightful holder owns the job now.
      }
    }
    return { type: "suspended" }
  }

  /** The portion of a tick that runs while holding the instance lock. */
  private async runLocked(processor: DurableProcessor): Promise<TickResult> {
    const { store, instanceId } = this.params

    // Begin-tick: creates the instance on first delivery, otherwise atomically
    // bumps runCount and flips status to running (compensating preserved).
    const instance = await store.initInstance({
      instanceId,
      queueName: this.params.queueName,
      jobName: this.params.jobName,
      jobId: this.params.originalJobId,
      input: this.params.jobData,
    })

    // Already-finished instances replay their outcome idempotently: a manual
    // `job.retry()` of a terminally-failed run lands back in `failed` (with the
    // stored error) instead of re-running business code.
    if (instance.status === "completed") {
      return { type: "completed", output: instance.output }
    }
    if (instance.status === "failed" || instance.status === "compensation_failed") {
      return {
        type: "failed",
        error: instance.error ? deserializeError(instance.error) : new Error("Instance failed"),
      }
    }
    if (instance.status === "cancelled") {
      return { type: "cancelled" }
    }

    this.runCount = instance.runCount
    this.enteredCompensating = instance.status === "compensating"

    return this.execute(processor)
  }

  /** Run the processor and persist the terminal/yield outcome. */
  private async execute(processor: DurableProcessor): Promise<TickResult> {
    const { store, instanceId } = this.params
    const ctx = this.buildContext()

    try {
      const output = await processor(this.params.job as unknown as DurableJob, ctx)
      await ctx.awaitQuiescence()

      // §compensating hardening: a tick that entered mid-compensation replays
      // the forward phase ONLY to re-register rollback closures. Even if that
      // replay "succeeds" (a flaky non-step section), the run is already failing
      // — route back into the failure sequence with the persisted trigger.
      if (this.enteredCompensating) {
        return await this.runFailureSequence(ctx, this.settleTrigger())
      }

      const settled = await store.completeInstance(instanceId, output, this.lockToken)
      if (!settled) {
        // Fenced out (or the instance vanished): another holder owns this run.
        return { type: "suspended" }
      }
      return { type: "completed", output }
    } catch (error) {
      // Let detached sibling steps settle before ANY finalisation — their
      // writes must not race the next tick (or the failure sequence below).
      await ctx.awaitQuiescence()

      if (error instanceof DurableYieldError) {
        await store.updateInstance(instanceId, { status: "yielded" })
        const resume = ctx.takePendingResume() ?? {
          delayMs: DEFAULT_RESUME_DELAY_MS,
          reason: "yield",
        }
        // moveToDelayed happens in run(), after the lock is released.
        return { type: "yield-pending", resume }
      }
      if (error instanceof DurableCancelledError) {
        await store.cancelInstance(instanceId, this.lockToken)
        return { type: "cancelled" }
      }
      if (error instanceof SettleIncompleteError) {
        // Settlement replay reached the run's frontier — settle it now.
        return await this.runFailureSequence(ctx, this.settleTrigger())
      }

      if (this.enteredCompensating) {
        return await this.runFailureSequence(ctx, this.settleTrigger(error))
      }

      // -- Two-budget classification (§3) ------------------------------------
      // Step-scoped failures consumed the STEP retry budget: the failure is
      // checkpointed and would replay identically, so burning job attempts on
      // re-deliveries is pure noise — settle now. Classified by the ERROR'S
      // identity (marker), not by context state: a step failure the user caught
      // and recovered from must not drag a later unrelated transient error into
      // terminal settlement.
      const stepScoped = isStepFailure(error)
      const unrecoverable =
        error instanceof UnrecoverableError ||
        (error as Error | undefined)?.name === "UnrecoverableError" ||
        error instanceof DurableNonRetryableError ||
        this.params.job?.discarded === true

      const attemptsTotal = this.params.job?.opts?.attempts ?? 1
      const attemptsRemain = this.jobAttempt < attemptsTotal

      if (this.mode === "normal" && !stepScoped && !unrecoverable && attemptsRemain) {
        // Non-step error with job attempts left: BullMQ's own attempts/backoff
        // (including custom backoffStrategy) drive the re-delivery; the replay
        // makes re-execution safe. Mark yielded so dashboards don't see a
        // stale "running" while the job waits out its backoff.
        await store.updateInstance(instanceId, { status: "yielded" })
        return { type: "retriable", error }
      }

      // Fast path / parity with 0.1.x: no compensation registered and no
      // failure handler — fail straight to terminal, no `compensating` status.
      if (ctx.takeRollbacks().length === 0 && !this.params.onFailure) {
        if (ctx.lastFailedStep !== undefined) {
          await store.updateInstance(instanceId, { failedStep: ctx.lastFailedStep })
        }
        await store.failInstance(instanceId, error, this.lockToken)
        return { type: "failed", error }
      }

      return await this.runFailureSequence(ctx, error)
    }
  }

  /** The terminal trigger for settlement / resumed-compensation ticks. */
  private settleTrigger(fallback?: unknown): unknown {
    if (this.params.settleError !== undefined) return this.params.settleError
    return fallback ?? new Error("durable run failed (resumed compensation)")
  }

  /**
   * The terminal-failure sequence: (1) per-step compensation in reverse, then
   * (2) the `onFailure` handler, then a terminal transition (`failed` if every
   * compensation succeeded, `compensation_failed` otherwise). Re-entrant: a yield
   * from any compensation/failure step suspends with the instance still
   * `compensating`, and a re-delivery rebuilds and continues this sequence.
   */
  private async runFailureSequence(ctx: DurableContextImpl, error: unknown): Promise<TickResult> {
    const { store, instanceId } = this.params

    // Enter (or confirm) the compensating phase. Persist the triggering error +
    // failed step ONCE, on first entry; a resumed tick keeps the original.
    const current = await store.getInstance(instanceId)
    if (current?.status !== "compensating") {
      await store.updateInstance(instanceId, {
        status: "compensating",
        failureError: serializeError(error),
        failedStep: ctx.lastFailedStep,
      })
    }
    const triggerError =
      current?.failureError !== undefined ? deserializeError(current.failureError) : error
    const failedStep = current?.failedStep ?? ctx.lastFailedStep

    // -- Layer 1: per-step compensation (reverse call order, best-effort) -----
    let report: CompensationReport
    try {
      report = await this.runRollbacks(ctx, triggerError)
    } catch (e) {
      if (e instanceof DurableYieldError) {
        const resume = ctx.takePendingResume() ?? {
          delayMs: DEFAULT_RESUME_DELAY_MS,
          reason: "compensation yield",
        }
        return { type: "yield-pending", resume }
      }
      if (e instanceof DurableCancelledError) {
        await store.cancelInstance(instanceId, this.lockToken)
        return { type: "cancelled" }
      }
      throw e
    }

    // -- Layer 2: terminal-failure handler -----------------------------------
    if (this.params.onFailure) {
      ctx.setPhase("failure")
      const info: DurableFailureInfo = {
        error: triggerError,
        failedStep,
        completed: await this.completedMainSteps(),
        compensation: report,
      }
      try {
        await this.params.onFailure(this.params.job as unknown as DurableJob, ctx, info)
      } catch (e) {
        if (e instanceof DurableYieldError) {
          const resume = ctx.takePendingResume() ?? {
            delayMs: DEFAULT_RESUME_DELAY_MS,
            reason: "onFailure yield",
          }
          return { type: "yield-pending", resume }
        }
        if (e instanceof DurableCancelledError) {
          await store.cancelInstance(instanceId, this.lockToken)
          return { type: "cancelled" }
        }
        // The handler itself threw a real error after its own retries. Don't
        // loop forever — log it and still go terminal with the ORIGINAL error.
        console.error(`durable onFailure handler threw for instance ${instanceId}:`, e)
      }
    }

    return this.settleTerminal(ctx, triggerError, report)
  }

  /**
   * Run each registered compensation in reverse call order. A yield/cancel
   * suspends the whole sequence (rethrown). A genuine terminal failure of one
   * compensation is recorded and does NOT block the rest (independent undos).
   */
  private async runRollbacks(ctx: DurableContextImpl, error: unknown): Promise<CompensationReport> {
    const report: CompensationReport = { rolledBack: [], failed: [] }
    const registered = ctx.takeRollbacks()
    if (registered.length === 0) return report

    void ctx.emitEvent("comp_start", {
      message: `compensating ${registered.length} step(s)`,
    })

    // Reverse of execution order, keyed by the persisted `seq` (stable across
    // resumes). Sorting by `seq` rather than registration order makes the order
    // deterministic even for steps started concurrently — registration order can
    // differ between the first failing tick and a compensation resume.
    const ordered = [...registered].sort((a, b) => b.seq - a.seq)

    ctx.setPhase("compensation")
    for (const rb of ordered) {
      const retry = rb.retry ?? this.params.defaultRollbackRetry ?? DEFAULT_ROLLBACK_RETRY
      try {
        await ctx.step(rb.key, { retry }, () => rb.handler({ output: rb.output, error }))
        report.rolledBack.push(rb.key)
        void ctx.emitEvent("comp_step", { message: `rolled back ${rb.key}`, step: rb.key })
      } catch (e) {
        if (e instanceof DurableYieldError || e instanceof DurableCancelledError) throw e
        report.failed.push({ key: rb.key, status: "failed", error: serializeError(e) })
        void ctx.emitEvent("comp_step", {
          message: `compensation for ${rb.key} failed`,
          step: rb.key,
          err: { name: serializeError(e).name, message: serializeError(e).message },
        })
      }
    }
    return report
  }

  /** The terminal transition, chosen by whether any compensation failed. */
  private async settleTerminal(
    ctx: DurableContextImpl,
    error: unknown,
    report: CompensationReport,
  ): Promise<TickResult> {
    const { store, instanceId } = this.params
    // Persist the compensation report as metadata before the terminal flip.
    if (report.rolledBack.length > 0 || report.failed.length > 0) {
      await store.updateInstance(instanceId, { compensation: report })
    }

    const compensationFailed = report.failed.length > 0
    void ctx.emitEvent("settled", {
      message: compensationFailed
        ? `run failed; ${report.failed.length} compensation(s) could not complete`
        : "run failed; compensation complete",
      err: { name: serializeError(error).name, message: serializeError(error).message },
    })

    const settled = compensationFailed
      ? await store.compensationFailedInstance(instanceId, error, this.lockToken)
      : await store.failInstance(instanceId, error, this.lockToken)
    if (!settled) {
      // Fenced out mid-settlement — the new holder will finish the job.
      return { type: "suspended" }
    }
    return { type: "failed", error }
  }

  /** The set of completed `main`-phase step keys (excludes sleeps + internal steps). */
  private async completedMainSteps(): Promise<ReadonlySet<string>> {
    const steps = await this.params.store.getSteps(this.params.instanceId)
    const set = new Set<string>()
    for (const s of steps) {
      if ((s.phase ?? "main") === "main" && s.type === "step" && s.status === "completed") {
        set.add(s.key)
      }
    }
    return set
  }

  /**
   * Periodically renew the instance lock so long-running ticks do not lose it.
   * The timer is unref'd so it never keeps the process alive on its own.
   * Renewal is best-effort: correctness comes from the token fence on terminal
   * transitions and on `moveToDelayed`, not from the lock never lapsing.
   */
  private startLockRenewal(): () => void {
    const { store, instanceId } = this.params
    const interval = Math.max(50, Math.floor(LOCK_TTL_MS / 3))
    const timer = setInterval(() => {
      void store.renewLock(instanceId, this.lockToken, LOCK_TTL_MS).catch(() => {
        // Best effort: a lost lock is caught by the terminal-transition fence.
      })
    }, interval)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
