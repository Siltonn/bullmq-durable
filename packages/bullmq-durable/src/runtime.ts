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
  DEFAULT_RETENTION,
  type DurableContext,
  type DurableJob,
  type DurableProcessor,
  type RetentionOptions,
  type StepOptions,
} from "./types"
import { parseDuration } from "./utils/duration"
import { deserializeError } from "./utils/serialize"

/** The result of a single execution tick. */
export type RunOutcome =
  | { type: "completed"; output: unknown }
  | { type: "yielded"; resume?: ScheduleResumeInput }
  | { type: "failed"; error: unknown; fresh: boolean }
  | { type: "cancelled" }
  | { type: "skipped" }

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
    if (instance.status === "failed") {
      return {
        type: "failed",
        error: instance.error ? deserializeError(instance.error) : new Error("Instance failed"),
        fresh: false,
      }
    }
    if (instance.status === "cancelled") {
      return { type: "cancelled" }
    }

    this.runCount = instance.runCount + 1
    await store.updateInstance(instanceId, { status: "running", runCount: this.runCount })

    return this.execute(processor)
  }

  /** Run the processor and persist the terminal/yield outcome. */
  private async execute(processor: DurableProcessor): Promise<RunOutcome> {
    const { store, instanceId } = this.params
    const ctx = this.buildContext()

    try {
      const output = await processor(this.params.job as DurableJob, ctx)
      await store.completeInstance(instanceId, output)
      await this.applyRetention("completed")
      return { type: "completed", output }
    } catch (error) {
      if (error instanceof DurableYieldError) {
        await store.updateInstance(instanceId, { status: "yielded" })
        // The resume is enqueued by `run()` once the lock has been released.
        return { type: "yielded", resume: ctx.takePendingResume() }
      }
      if (error instanceof DurableCancelledError) {
        await store.cancelInstance(instanceId)
        await this.applyRetention("cancelled")
        return { type: "cancelled" }
      }
      await store.failInstance(instanceId, error)
      await this.applyRetention("failed")
      return { type: "failed", error, fresh: true }
    }
  }

  /**
   * Bound a finished instance's state with a retention TTL once it reaches a
   * terminal state. Falls back to {@link DEFAULT_RETENTION} when unconfigured, so
   * the store never accumulates finished instances forever — applied for every
   * terminal status (completed / failed / cancelled).
   */
  private async applyRetention(kind: keyof RetentionOptions): Promise<void> {
    const ttl = this.params.retention?.[kind] ?? DEFAULT_RETENTION[kind]
    await this.params.store.expireInstance(this.params.instanceId, parseDuration(ttl))
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
