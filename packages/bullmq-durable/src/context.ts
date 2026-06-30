/**
 * The durable execution context (`ctx`) handed to processors.
 *
 * Each method is keyed by a stable string and backed by the {@link StateStore},
 * so a completed step / sleep replays as a cache hit instead of re-running. The
 * heavy lifting of "schedule a resume and unwind the processor" is funnelled
 * through {@link DurableContextImpl.yieldWithResume}.
 */

import {
  DurableCancelledError,
  DurableNonRetryableError,
  DurableRetriesExhaustedError,
  DurableYieldError,
  RetryLaterError,
} from "./errors"
import type { ScheduleResumeInput } from "./scheduler"
import type { StateStore } from "./store/state-store"
import type {
  DurableContext,
  DurableLog,
  RetryOptions,
  RollbackFn,
  StepFn,
  StepOptions,
  StepPhase,
} from "./types"
import { type DurationInput, hasExplicitDurationUnit, parseDuration } from "./utils/duration"
import { stepIdOf } from "./utils/keys"
import { computeBackoff, resolveRetry } from "./utils/retry"
import { cloneValue, deserializeError, serializeError } from "./utils/serialize"

/** A compensation registered by a completed step, captured during replay. */
export interface RegisteredRollback {
  /** The forward step's (raw) key. */
  key: string
  /** The forward step's checkpoint snapshot. */
  output: unknown
  handler: RollbackFn<unknown>
  retry?: RetryOptions
}

/** Minimal surface used to mirror durable logs onto the BullMQ job. */
export interface JobLogSink {
  log(message: string): Promise<unknown>
}

/** Everything a {@link DurableContextImpl} needs to operate. */
export interface DurableContextDeps {
  instanceId: string
  runCount: number
  queueName: string
  jobName: string
  jobData: unknown
  originalJobId: string
  store: StateStore
  defaultStepOptions?: StepOptions
  maxLogs: number
  job?: JobLogSink
}

export class DurableContextImpl implements DurableContext {
  readonly instanceId: string
  readonly runCount: number

  /**
   * A resume request recorded by the last yield. The runtime enqueues it only
   * *after* releasing the instance lock, so a zero-delay resume can never be
   * picked up by another worker while this tick still holds the lock.
   */
  private pendingResume?: ScheduleResumeInput

  /**
   * The lifecycle phase of the steps being run right now. The runtime flips this
   * to drive compensation / failure-handling against the same context. Storage
   * keys for non-`main` phases are namespaced so they never collide with the
   * forward run (see {@link storageKey}).
   */
  private phase: StepPhase = "main"

  /**
   * Compensations registered by completed steps during this tick's replay, in
   * call order. Only the in-memory closures here are runnable — the store keeps
   * step state/output, not functions — so compensation must run on the tick that
   * replayed them. See the runtime's failure sequence.
   */
  private readonly rollbacks: RegisteredRollback[] = []

  /** The (raw) key of the main-phase step whose failure triggered terminal-ness. */
  private failedStepKey?: string

  constructor(private readonly deps: DurableContextDeps) {
    this.instanceId = deps.instanceId
    this.runCount = deps.runCount
  }

  /** Hand the recorded resume request (if any) to the runtime, clearing it. */
  takePendingResume(): ScheduleResumeInput | undefined {
    const resume = this.pendingResume
    this.pendingResume = undefined
    return resume
  }

  /** Switch the active phase. Used by the runtime to drive compensation/failure. */
  setPhase(phase: StepPhase): void {
    this.phase = phase
  }

  /** Compensations registered so far (call order), snapshotted for the runtime. */
  takeRollbacks(): RegisteredRollback[] {
    return [...this.rollbacks]
  }

  /** The main-phase step whose failure triggered the terminal sequence, if any. */
  get lastFailedStep(): string | undefined {
    return this.failedStepKey
  }

  /** Namespace a step key by phase so compensation/failure never collide with main. */
  private storageKey(key: string): string {
    if (this.phase === "compensation") return `__rollback__:${key}`
    if (this.phase === "failure") return `__failure__:${key}`
    return key
  }

  /** Record a completed step's `onRollback` closure (main phase only). */
  private registerRollback(key: string, output: unknown, options: StepOptions<any>): void {
    if (this.phase !== "main" || !options.onRollback) return
    const onRb = options.onRollback
    const handler = (typeof onRb === "function" ? onRb : onRb.handler) as RollbackFn<unknown>
    const retry = typeof onRb === "function" ? undefined : onRb.retry
    this.rollbacks.push({ key, output, handler, retry })
  }

  // -- Steps ---------------------------------------------------------------

  step<T>(key: string, fn: StepFn<T>): Promise<T>
  step<T>(key: string, options: StepOptions<T>, fn: StepFn<T>): Promise<T>
  async step<T>(
    key: string,
    optionsOrFn: StepOptions<T> | StepFn<T>,
    maybeFn?: StepFn<T>,
  ): Promise<T> {
    const { options, fn } = normalizeStepArgs<T>(optionsOrFn, maybeFn)
    await this.assertNotCancelled()

    const storeKey = this.storageKey(key)
    const existing = await this.deps.store.getStep(this.instanceId, storeKey)
    if (existing?.status === "completed") {
      // Replay: return the checkpointed result without re-running the body. The
      // rollback closure is re-registered from the CURRENT code's options.
      this.registerRollback(key, existing.result, options)
      return existing.result as T
    }
    if (existing?.status === "failed") {
      // A terminally-failed step replays its error WITHOUT re-running the body —
      // symmetric with a completed step replaying its result. This stops a failed
      // step's side effect from re-firing on every compensation resume, and makes
      // the forward-vs-compensation split deterministic (see runtime §6.8).
      if (this.phase === "main") this.failedStepKey = key
      throw deserializeError(existing.error ?? { name: "Error", message: `Step "${key}" failed` })
    }

    const attempts = (existing?.attempts ?? 0) + 1
    const startedAt = existing?.startedAt ?? Date.now()
    // `seq` is allocated once, at the step's first persist, and reused on replay.
    const seq = existing?.seq ?? (await this.deps.store.nextStepSeq(this.instanceId))

    await this.deps.store.saveStep(this.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.phase,
      seq,
      status: "running",
      attempts,
      startedAt,
    })

    try {
      const result = await fn()
      // Persist and return the *cloned* result so the first run observes exactly
      // what a later replay would: a store round-trip is a JSON round-trip, which
      // turns Dates into strings, drops `undefined`, etc. Returning the live value
      // here would let code work on the first tick and crash on resume.
      const checkpointed = cloneValue(result)
      await this.deps.store.saveStep(this.instanceId, storeKey, {
        key,
        type: "step",
        phase: this.phase,
        seq,
        status: "completed",
        result: checkpointed,
        attempts,
        startedAt,
        completedAt: Date.now(),
      })
      this.registerRollback(key, checkpointed, options)
      return checkpointed
    } catch (error) {
      return await this.handleStepError<T>(key, storeKey, seq, error, options, attempts, startedAt)
    }
  }

  /**
   * Decide what to do when a step body throws. Either schedule a retry (and
   * yield), fail the instance, or bubble a control-flow signal.
   */
  private async handleStepError<T>(
    key: string,
    storeKey: string,
    seq: number,
    error: unknown,
    options: StepOptions<any>,
    attempts: number,
    startedAt: number,
  ): Promise<T> {
    // A nested yield should never be swallowed by a step's retry handling.
    if (error instanceof DurableYieldError || error instanceof DurableCancelledError) {
      throw error
    }

    // Non-retryable: fail the whole instance immediately.
    if (error instanceof DurableNonRetryableError) {
      await this.failStep(key, storeKey, seq, error, attempts, startedAt)
      throw error
    }

    const retry = resolveRetry(options.retry, this.deps.defaultStepOptions?.retry)
    const isRetryLater = error instanceof RetryLaterError

    // `retryLater` is an expected "still pending" signal, not a failure. By
    // default it keeps polling until the step stops throwing it; an explicit
    // `attempts` (step- or worker-level) caps the number of polls. A genuine
    // error is always bounded by the resolved `attempts` (default 1 = no retry).
    const attemptsConfigured =
      options.retry?.attempts ?? this.deps.defaultStepOptions?.retry?.attempts
    const maxAttempts =
      isRetryLater && attemptsConfigured === undefined ? Number.POSITIVE_INFINITY : retry.attempts

    if (attempts < maxAttempts) {
      const delayMs =
        isRetryLater && error.delayMs !== undefined
          ? error.delayMs
          : computeBackoff(retry, attempts)

      await this.deps.store.saveStep(this.instanceId, storeKey, {
        key,
        type: "step",
        phase: this.phase,
        seq,
        // Stays "running": the step is mid-flight and will resume. We only
        // record an `error` for genuine failures, not expected retry-later.
        status: "running",
        attempts,
        startedAt,
        nextRunAt: Date.now() + delayMs,
        ...(isRetryLater ? {} : { error: serializeError(error), failedAt: Date.now() }),
      })

      const reason = isRetryLater ? error.reason : `${key} failed, retrying`
      await this.yieldWithResume(delayMs, `step:${reason}`)
    }

    // Retry budget exhausted.
    await this.failStep(key, storeKey, seq, error, attempts, startedAt)
    if (isRetryLater) {
      throw new DurableRetriesExhaustedError(key, attempts, serializeError(error))
    }
    throw error
  }

  private async failStep(
    key: string,
    storeKey: string,
    seq: number,
    error: unknown,
    attempts: number,
    startedAt: number,
  ): Promise<void> {
    // Record which forward step triggered the terminal sequence so the runtime
    // can surface it in `DurableFailureInfo.failedStep`.
    if (this.phase === "main") this.failedStepKey = key
    await this.deps.store.saveStep(this.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.phase,
      seq,
      status: "failed",
      error: serializeError(error),
      attempts,
      startedAt,
      failedAt: Date.now(),
    })
  }

  // -- Sleep ---------------------------------------------------------------

  async sleep(key: string, duration: DurationInput): Promise<void> {
    await this.sleepFor(key, parseDuration(duration))
  }

  async sleepUntil(key: string, date: Date | number): Promise<void> {
    const target = date instanceof Date ? date.getTime() : date
    await this.sleepFor(key, target - Date.now())
  }

  private async sleepFor(key: string, delayMs: number): Promise<void> {
    await this.assertNotCancelled()

    const storeKey = this.storageKey(key)
    const existing = await this.deps.store.getStep(this.instanceId, storeKey)
    if (existing?.status === "completed") {
      // Replay: the sleep already elapsed, fall through.
      return
    }

    const now = Date.now()
    const seq = existing?.seq ?? (await this.deps.store.nextStepSeq(this.instanceId))
    // A sleep is recorded as a completed step so the resume tick skips past it.
    await this.deps.store.saveStep(this.instanceId, storeKey, {
      key,
      type: "sleep",
      phase: this.phase,
      seq,
      status: "completed",
      attempts: 1,
      result: { resumeAt: now + Math.max(0, delayMs) },
      startedAt: now,
      completedAt: now,
    })

    if (delayMs <= 0) {
      // Nothing to wait for — continue inline rather than scheduling a 0ms tick.
      return
    }

    await this.yieldWithResume(delayMs, `sleep:${key}`)
  }

  // -- Control-flow helpers ------------------------------------------------

  retryLater(reason?: string): RetryLaterError
  retryLater(delay: DurationInput, reason?: string): RetryLaterError
  retryLater(reasonOrDelay?: DurationInput, maybeReason?: string): RetryLaterError {
    if (maybeReason !== undefined) {
      return new RetryLaterError(parseDuration(reasonOrDelay as DurationInput), maybeReason)
    }
    if (reasonOrDelay === undefined) {
      return new RetryLaterError()
    }
    // Single argument: a number, or a unit-qualified string like "10s", is a
    // delay. Any other string — including a bare number like "30" — is a reason,
    // so a numeric-looking reason is never silently turned into a delay.
    if (typeof reasonOrDelay === "number" || hasExplicitDurationUnit(reasonOrDelay)) {
      return new RetryLaterError(parseDuration(reasonOrDelay))
    }
    return new RetryLaterError(undefined, String(reasonOrDelay))
  }

  nonRetryable(reason: string): DurableNonRetryableError {
    return new DurableNonRetryableError(reason)
  }

  // -- Logging -------------------------------------------------------------

  async log(message: string, meta?: Record<string, unknown>): Promise<void> {
    const entry: DurableLog = {
      message,
      timestamp: Date.now(),
      ...(meta ? { meta } : {}),
    }
    await this.deps.store.appendLog(this.instanceId, entry, this.deps.maxLogs)

    // Best-effort mirror to BullMQ job logs; never let logging break execution.
    if (this.deps.job) {
      try {
        await this.deps.job.log(meta ? `${message} ${JSON.stringify(meta)}` : message)
      } catch {
        // ignore
      }
    }
  }

  stepId(key: string): string {
    return stepIdOf(this.instanceId, key)
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Allocate a resume sequence, record the resume request, then unwind the
   * processor with a {@link DurableYieldError}. The runtime enqueues the resume
   * after the lock is released. Never returns normally.
   */
  private async yieldWithResume(delayMs: number, reason: string): Promise<never> {
    const resumeSeq = await this.deps.store.nextResumeSeq(this.instanceId)
    this.pendingResume = {
      instanceId: this.instanceId,
      queueName: this.deps.queueName,
      jobName: this.deps.jobName,
      jobData: this.deps.jobData,
      originalJobId: this.deps.originalJobId,
      resumeSeq,
      delayMs,
      reason,
    }
    throw new DurableYieldError(reason)
  }

  private async assertNotCancelled(): Promise<void> {
    const instance = await this.deps.store.getInstance(this.instanceId)
    if (!instance || instance.status === "cancelled") {
      throw new DurableCancelledError(this.instanceId)
    }
  }
}

/** Disambiguate the `step(key, fn)` and `step(key, options, fn)` overloads. */
function normalizeStepArgs<T>(
  optionsOrFn: StepOptions<any> | StepFn<T>,
  maybeFn?: StepFn<T>,
): { options: StepOptions<any>; fn: StepFn<T> } {
  if (typeof optionsOrFn === "function") {
    return { options: {}, fn: optionsOrFn }
  }
  if (!maybeFn) {
    throw new TypeError("ctx.step requires a callback function")
  }
  return { options: optionsOrFn, fn: maybeFn }
}
