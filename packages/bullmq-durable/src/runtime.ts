/**
 * Per-tick execution runtime.
 *
 * A {@link DurableRuntime} drives exactly one execution tick for one instance:
 * acquire the instance lock, lazily create the instance, bail out if it is
 * already finished, run the user processor against a fresh {@link DurableContext},
 * then persist the outcome (completed / yielded / failed / cancelled).
 *
 * The worker translates the returned {@link RunOutcome} into BullMQ semantics.
 */

import { randomUUID } from "node:crypto"
import { DurableContextImpl, type JobLogSink } from "./context"
import { DurableCancelledError, DurableYieldError } from "./errors"
import type { ResumeScheduler, ScheduleResumeInput } from "./scheduler"
import type { StateStore } from "./store/state-store"
import {
  type CompensationReport,
  DEFAULT_RETENTION,
  type DurableContext,
  type DurableFailureHandler,
  type DurableFailureInfo,
  type DurableJob,
  type DurableProcessor,
  type RetentionOptions,
  type RetryOptions,
  type StepOptions,
} from "./types"
import { parseDuration } from "./utils/duration"
import { deserializeError, serializeError } from "./utils/serialize"

/** The result of a single execution tick. */
export type RunOutcome =
  | { type: "completed"; output: unknown }
  | { type: "yielded"; resume?: ScheduleResumeInput }
  | { type: "failed"; error: unknown; fresh: boolean; compensationFailed?: boolean }
  | { type: "cancelled" }
  | { type: "skipped" }

/**
 * Default retry for `onRollback` compensations that don't set their own.
 * Compensations should be tried hard before giving up (a stuck compensation is
 * an operational escalation, not a silent loss).
 */
const DEFAULT_ROLLBACK_RETRY: RetryOptions = {
  attempts: 5,
  backoff: "exponential",
  delay: "1s",
  maxDelay: "30s",
}

export interface DurableRuntimeParams {
  instanceId: string
  queueName: string
  jobName: string
  /** The original user payload (durable metadata already stripped). */
  jobData: unknown
  originalJobId: string
  /** The BullMQ job, exposed to the processor and used for log mirroring. */
  job?: DurableJob & JobLogSink
  store: StateStore
  scheduler: ResumeScheduler
  defaultStepOptions?: StepOptions
  /** Default retry for `onRollback` compensations that don't set their own. */
  defaultRollbackRetry?: RetryOptions
  /** Terminal-failure handler, run after compensation. */
  onFailure?: DurableFailureHandler
  retention?: RetentionOptions
  /** Instance lock TTL in milliseconds. */
  lockTimeoutMs: number
  maxLogs: number
}

export class DurableRuntime {
  private runCount = 1
  private readonly lockToken = randomUUID()

  constructor(private readonly params: DurableRuntimeParams) {}

  /** Build a context bound to this tick. Exposed for white-box testing. */
  createContext(): DurableContext {
    return this.buildContext()
  }

  private buildContext(): DurableContextImpl {
    return new DurableContextImpl({
      instanceId: this.params.instanceId,
      runCount: this.runCount,
      queueName: this.params.queueName,
      jobName: this.params.jobName,
      jobData: this.params.jobData,
      originalJobId: this.params.originalJobId,
      store: this.params.store,
      defaultStepOptions: this.params.defaultStepOptions,
      maxLogs: this.params.maxLogs,
      job: this.params.job,
    })
  }

  /**
   * Run one execution tick end to end. The instance lock is held only for the
   * locked section; a yielded resume is enqueued *after* the lock is released so
   * a zero-delay resume can never be skipped by a worker contending for a lock
   * we still hold. (A crash in that window is recovered by BullMQ re-delivery,
   * since this job has not completed yet.)
   */
  async run(processor: DurableProcessor): Promise<RunOutcome> {
    const { store, instanceId, lockTimeoutMs } = this.params

    const acquired = await store.acquireLock(instanceId, this.lockToken, lockTimeoutMs)
    if (!acquired) {
      // Another worker is already advancing this instance — nothing to do.
      return { type: "skipped" }
    }

    const stopRenewal = this.startLockRenewal()
    let outcome: RunOutcome
    try {
      outcome = await this.runLocked(processor)
    } finally {
      stopRenewal()
      await store.releaseLock(instanceId, this.lockToken)
    }

    if (outcome.type === "yielded" && outcome.resume) {
      await this.params.scheduler.scheduleResume(outcome.resume)
    }
    return outcome
  }

  /** The portion of a tick that runs while holding the instance lock. */
  private async runLocked(processor: DurableProcessor): Promise<RunOutcome> {
    const { store, instanceId } = this.params

    const instance = await store.initInstance({
      instanceId,
      queueName: this.params.queueName,
      jobName: this.params.jobName,
      jobId: this.params.originalJobId,
      input: this.params.jobData,
    })

    // Already-finished instances are idempotent no-ops for stray resumes.
    if (instance.status === "completed") {
      return { type: "completed", output: instance.output }
    }
    if (instance.status === "failed" || instance.status === "compensation_failed") {
      return {
        type: "failed",
        error: instance.error ? deserializeError(instance.error) : new Error("Instance failed"),
        fresh: false,
        ...(instance.status === "compensation_failed" ? { compensationFailed: true } : {}),
      }
    }
    if (instance.status === "cancelled") {
      return { type: "cancelled" }
    }

    this.runCount = instance.runCount + 1
    // A compensating resume stays `compensating` (the failure sequence re-runs);
    // otherwise we're on the forward path and mark `running`.
    const patch: Partial<{ status: "running"; runCount: number }> = { runCount: this.runCount }
    if (instance.status !== "compensating") patch.status = "running"
    await store.updateInstance(instanceId, patch)

    return this.execute(processor)
  }

  /** Run the processor and persist the terminal/yield outcome. */
  private async execute(processor: DurableProcessor): Promise<RunOutcome> {
    const { store, instanceId } = this.params
    const ctx = this.buildContext()

    try {
      const output = await processor(this.params.job as DurableJob, ctx)
      await store.completeInstance(instanceId, output, this.retentionMs("completed"))
      return { type: "completed", output }
    } catch (error) {
      if (error instanceof DurableYieldError) {
        await store.updateInstance(instanceId, { status: "yielded" })
        // The resume is enqueued by `run()` once the lock has been released.
        return { type: "yielded", resume: ctx.takePendingResume() }
      }
      if (error instanceof DurableCancelledError) {
        await store.cancelInstance(instanceId, this.retentionMs("cancelled"))
        return { type: "cancelled" }
      }
      // Fast path / back-compat: with no compensation and no failure handler,
      // behave exactly like 0.1.x — fail straight to terminal, no `compensating`.
      if (ctx.takeRollbacks().length === 0 && !this.params.onFailure) {
        await store.failInstance(instanceId, error, this.retentionMs("failed"))
        return { type: "failed", error, fresh: true }
      }
      // A genuine error escaped the forward processor → run the failure sequence.
      return this.runFailureSequence(ctx, error)
    }
  }

  /**
   * The terminal-failure sequence: (1) per-step compensation in reverse, then
   * (2) the `onFailure` handler, then a terminal transition (`failed` if every
   * compensation succeeded, `compensation_failed` otherwise). Re-entrant: a yield
   * from any compensation/failure step suspends with the instance still
   * `compensating`, and a resume rebuilds and continues this sequence.
   */
  private async runFailureSequence(ctx: DurableContextImpl, error: unknown): Promise<RunOutcome> {
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
      if (e instanceof DurableYieldError)
        return { type: "yielded", resume: ctx.takePendingResume() }
      if (e instanceof DurableCancelledError) {
        await store.cancelInstance(instanceId, this.retentionMs("cancelled"))
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
        await this.params.onFailure(this.params.job as DurableJob, ctx, info)
      } catch (e) {
        if (e instanceof DurableYieldError) {
          return { type: "yielded", resume: ctx.takePendingResume() }
        }
        if (e instanceof DurableCancelledError) {
          await store.cancelInstance(instanceId, this.retentionMs("cancelled"))
          return { type: "cancelled" }
        }
        // §6.6: the handler itself threw a real error after its own retries.
        // Don't loop forever — log it and still go terminal with the ORIGINAL error.
        console.error(`durable onFailure handler threw for instance ${instanceId}:`, e)
      }
    }

    return this.settleTerminal(triggerError, report)
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
      } catch (e) {
        if (e instanceof DurableYieldError || e instanceof DurableCancelledError) throw e
        report.failed.push({ key: rb.key, status: "failed", error: serializeError(e) })
      }
    }
    return report
  }

  /** The terminal transition, chosen by whether any compensation failed. */
  private async settleTerminal(error: unknown, report: CompensationReport): Promise<RunOutcome> {
    const { store, instanceId } = this.params
    // Persist the compensation report as metadata before the terminal flip.
    if (report.rolledBack.length > 0 || report.failed.length > 0) {
      await store.updateInstance(instanceId, { compensation: report })
    }
    if (report.failed.length > 0) {
      await store.compensationFailedInstance(
        instanceId,
        error,
        this.retentionMs("compensationFailed"),
      )
      return { type: "failed", error, fresh: true, compensationFailed: true }
    }
    await store.failInstance(instanceId, error, this.retentionMs("failed"))
    return { type: "failed", error, fresh: true }
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
   * Resolve the retention TTL (ms) for a terminal status, falling back to
   * {@link DEFAULT_RETENTION} when unconfigured. Passed straight into the terminal
   * transition so a finished instance is bounded atomically — the store never
   * accumulates finished instances forever, and there is no window between the
   * status flip and the TTL where a crash could leak un-expired state.
   */
  private retentionMs(kind: keyof RetentionOptions): number {
    return parseDuration(this.params.retention?.[kind] ?? DEFAULT_RETENTION[kind])
  }

  /**
   * Periodically renew the instance lock so long-running ticks do not lose it.
   * The timer is unref'd so it never keeps the process alive on its own.
   */
  private startLockRenewal(): () => void {
    const { store, instanceId, lockTimeoutMs } = this.params
    // Renew at roughly a third of the TTL so the lock is refreshed ~3x before it
    // would expire. The floor is small (not 1s) so short lock timeouts are still
    // renewed *before* they lapse rather than after.
    const interval = Math.max(50, Math.floor(lockTimeoutMs / 3))
    const timer = setInterval(() => {
      void store.renewLock(instanceId, this.lockToken, lockTimeoutMs).catch(() => {
        // Best effort: a lost lock surfaces as a conflicting write elsewhere.
      })
    }, interval)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
