/**
 * The durable execution context (`ctx`) handed to processors.
 *
 * Each method is keyed by a stable string and backed by the {@link StateStore},
 * so a completed step / sleep replays as a cache hit instead of re-running. A
 * suspension ("wait, then come back") is funnelled through
 * {@link DurableContextImpl.yieldWithResume}: the runtime turns it into
 * `job.moveToDelayed` on the run's single BullMQ job.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import {
  DurableCancelledError,
  DurableNonRetryableError,
  DurableRetriesExhaustedError,
  DurableYieldError,
  markStepFailure,
  RetryLaterError,
} from "./errors"
import type { StateStore } from "./store/state-store"
import type {
  DurableContext,
  DurableLogEntry,
  DurableLogEvent,
  RetryOptions,
  RollbackFn,
  StepFn,
  StepOptions,
  StepPhase,
} from "./types"
import { type DurationInput, hasExplicitDurationUnit, parseDuration } from "./utils/duration"
import { stepIdOf } from "./utils/keys"
import { serializeLogEntry } from "./utils/log"
import { computeBackoff, resolveRetry } from "./utils/retry"
import { cloneValue, deserializeError, serializeError } from "./utils/serialize"

/** A compensation registered by a completed step, captured during replay. */
export interface RegisteredRollback {
  /** The forward step's (raw) key. */
  key: string
  /** The forward step's monotonic seq — the stable order key for reverse compensation. */
  seq: number
  /** The forward step's checkpoint snapshot. */
  output: unknown
  handler: RollbackFn<unknown>
  retry?: RetryOptions
}

/** The suspension recorded by the last yield: how long until re-delivery. */
export interface PendingResume {
  delayMs: number
  reason: string
}

/** Minimal surface used to write durable logs onto the BullMQ job. */
export interface JobLogSink {
  log(message: string): Promise<unknown>
}

/**
 * Internal signal: a stall-settlement replay hit a step that never completed.
 * The runtime routes this into the failure sequence with the settlement's
 * triggering error — the half-dead run must not execute new side effects.
 */
export class SettleIncompleteError extends Error {
  constructor(readonly stepKey: string) {
    super(`settlement replay reached incomplete step "${stepKey}"`)
    this.name = "SettleIncompleteError"
  }
}

/**
 * `"normal"` — a live tick on the run's own job (suspensions moveToDelayed).
 * `"settle"` — a post-mortem tick from the `failed`-event listener: the forward
 * phase is replay-only (no side effects), and compensation retries wait
 * in-process because there is no job left to delay.
 */
export type RunMode = "normal" | "settle"

/** Everything a {@link DurableContextImpl} needs to operate. */
export interface DurableContextDeps {
  instanceId: string
  runCount: number
  store: StateStore
  defaultStepOptions?: StepOptions
  /** Sink for durable log lines (the BullMQ job). Absent → logging is a no-op. */
  job?: JobLogSink
  /** attemptsMade + 1 of the current delivery (real failures only). */
  jobAttempt?: number
  mode?: RunMode
  /**
   * Time source for scheduling decisions (wake times, backoff). Injectable so
   * the test engine can advance a virtual clock instead of sleeping for real.
   */
  clock?: () => number
}

/** Tracks which step (and attempt) is executing, across concurrent steps. */
const currentStep = new AsyncLocalStorage<{ key: string; attempt: number }>()

export class DurableContextImpl implements DurableContext {
  readonly instanceId: string
  readonly runCount: number

  /**
   * The suspension recorded by yields this tick. Concurrent steps may each
   * yield; the EARLIEST due time wins (every path replays on resume anyway).
   * The runtime reads it after the processor unwinds and turns it into
   * `moveToDelayed`.
   */
  private pendingResume?: PendingResume

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

  /**
   * Step promises still in flight. `Promise.all` unwinds on the FIRST yield,
   * but sibling steps keep executing detached — the runtime must wait for them
   * to settle (via {@link awaitQuiescence}) before it releases the lock and
   * suspends, or their writes would race the next tick.
   */
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(private readonly deps: DurableContextDeps) {
    this.instanceId = deps.instanceId
    this.runCount = deps.runCount
  }

  private get mode(): RunMode {
    return this.deps.mode ?? "normal"
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now()
  }

  /** Hand the recorded resume request (if any) to the runtime, clearing it. */
  takePendingResume(): PendingResume | undefined {
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

  /**
   * Wait until every in-flight step promise has settled. Called by the runtime
   * before it finalises the tick (release lock / moveToDelayed / terminal
   * transition), so no detached sibling keeps writing after the tick ends.
   * Also attaches handlers to sibling rejections, preventing spurious
   * unhandled-rejection crashes when `Promise.all` unwound early.
   */
  async awaitQuiescence(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  /** Namespace a step key by phase so compensation/failure never collide with main. */
  private storageKey(key: string): string {
    if (this.phase === "compensation") return `__rollback__:${key}`
    if (this.phase === "failure") return `__failure__:${key}`
    return key
  }

  /** Record a completed step's `onRollback` closure (main phase only). */
  private registerRollback(
    key: string,
    seq: number,
    output: unknown,
    options: StepOptions<any>,
  ): void {
    if (this.phase !== "main" || !options.onRollback) return
    const onRb = options.onRollback
    const handler = (typeof onRb === "function" ? onRb : onRb.handler) as RollbackFn<unknown>
    const retry = typeof onRb === "function" ? undefined : onRb.retry
    this.rollbacks.push({ key, seq, output, handler, retry })
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
    const promise = this.executeStep(key, options, fn)
    this.inFlight.add(promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(promise)
    }
  }

  private async executeStep<T>(key: string, options: StepOptions<T>, fn: StepFn<T>): Promise<T> {
    const storeKey = this.storageKey(key)

    // Settlement replays the forward phase READ-ONLY: registered rollbacks come
    // from completed steps; the first incomplete step ends the replay. No new
    // step records, no side effects, on a run whose job already failed.
    if (this.mode === "settle" && this.phase === "main") {
      const existing = await this.deps.store.getStep(this.instanceId, storeKey)
      if (existing?.status === "completed") {
        this.registerRollback(key, existing.seq ?? 0, existing.result, options)
        return existing.result as T
      }
      if (existing?.status === "failed") {
        this.failedStepKey = key
        throw markStepFailure(
          deserializeError(existing.error ?? { name: "Error", message: `Step "${key}" failed` }),
        )
      }
      throw new SettleIncompleteError(key)
    }

    const now = this.now()
    const begin = await this.deps.store.beginStep(this.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.phase,
      now,
    })

    if (begin.kind === "missing" || begin.kind === "cancelled") {
      throw new DurableCancelledError(this.instanceId)
    }

    let attempts: number
    let seq: number
    let startedAt: number

    if (begin.kind === "existing") {
      const existing = begin.step
      if (existing.status === "completed") {
        // Replay: return the checkpointed result without re-running the body.
        // The rollback closure is re-registered from the CURRENT code's options.
        this.registerRollback(key, existing.seq ?? 0, existing.result, options)
        return existing.result as T
      }
      if (existing.status === "failed") {
        // A terminally-failed step replays its error WITHOUT re-running the body —
        // symmetric with a completed step replaying its result. This stops a failed
        // step's side effect from re-firing on every compensation resume, and makes
        // the forward-vs-compensation split deterministic.
        if (this.phase === "main") this.failedStepKey = key
        throw markStepFailure(
          deserializeError(existing.error ?? { name: "Error", message: `Step "${key}" failed` }),
        )
      }

      // `running` — a scheduled retry, or crash recovery mid-attempt. Honour the
      // persisted backoff: an early re-delivery (stall takeover, promote) must
      // NOT run the attempt ahead of its nextRunAt.
      if (existing.nextRunAt !== undefined && existing.nextRunAt > now) {
        await this.waitOrYield("backoff", existing.nextRunAt - now, `step:${key} backoff`)
      }
      attempts = existing.attempts + 1
      seq = existing.seq ?? 0
      startedAt = existing.startedAt ?? now
      // Full-state write: clears any stale nextRunAt for the new attempt.
      await this.deps.store.saveStep(this.instanceId, storeKey, {
        key,
        type: "step",
        phase: this.phase,
        seq,
        status: "running",
        attempts,
        startedAt,
      })
    } else {
      // Fresh step: beginStep already persisted the `running` record.
      attempts = 1
      seq = begin.seq
      startedAt = now
    }

    for (;;) {
      try {
        const result = await currentStep.run({ key, attempt: attempts }, () => fn())
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
          completedAt: this.now(),
        })
        this.registerRollback(key, seq, checkpointed, options)
        return checkpointed
      } catch (error) {
        const retryDelayMs = await this.handleStepError(
          key,
          storeKey,
          seq,
          error,
          options,
          attempts,
          startedAt,
        )
        // Reached only in settle mode: wait in-process, then try again.
        await sleepInProcess(retryDelayMs)
        attempts += 1
        await this.deps.store.saveStep(this.instanceId, storeKey, {
          key,
          type: "step",
          phase: this.phase,
          seq,
          status: "running",
          attempts,
          startedAt,
        })
      }
    }
  }

  /**
   * Decide what to do when a step body throws. In normal mode this never
   * returns: it either yields (retry scheduled via the job's own delay), or
   * fails the step and rethrows. In settle mode a retryable failure RETURNS the
   * backoff delay so the caller can wait in-process (there is no job to delay).
   */
  private async handleStepError(
    key: string,
    storeKey: string,
    seq: number,
    error: unknown,
    options: StepOptions<any>,
    attempts: number,
    startedAt: number,
  ): Promise<number> {
    // A nested yield should never be swallowed by a step's retry handling.
    if (error instanceof DurableYieldError || error instanceof DurableCancelledError) {
      throw error
    }

    // Non-retryable: fail the whole instance immediately.
    if (error instanceof DurableNonRetryableError) {
      await this.failStep(key, storeKey, seq, error, attempts, startedAt)
      throw markStepFailure(error)
    }

    const retry = resolveRetry(options.retry, this.deps.defaultStepOptions?.retry)
    const isRetryLater = error instanceof RetryLaterError

    // `retryLater` is an expected "still pending" signal, not a failure. By
    // default it keeps polling until the step stops throwing it; an explicit
    // `attempts` (step- or worker-level) caps the number of polls. A genuine
    // error is always bounded by the resolved `attempts` (default 1 = no retry).
    // Settlement never polls unbounded — there is no job to carry a long wait.
    const attemptsConfigured =
      options.retry?.attempts ?? this.deps.defaultStepOptions?.retry?.attempts
    const maxAttempts =
      isRetryLater && attemptsConfigured === undefined && this.mode === "normal"
        ? Number.POSITIVE_INFINITY
        : retry.attempts

    if (attempts < maxAttempts) {
      const delayMs =
        isRetryLater && error.delayMs !== undefined ? error.delayMs : computeBackoff(retry, attempts)

      if (!isRetryLater) {
        void this.emitEvent("step_retry", {
          message: `step ${key} attempt ${attempts}/${maxAttempts} failed, retry in ${delayMs}ms`,
          step: key,
          stepAttempt: attempts,
          err: compactError(error),
          retryInMs: delayMs,
        })
      }

      if (this.mode === "settle") {
        // Record the failure for observability, then let the caller loop.
        await this.deps.store.saveStep(this.instanceId, storeKey, {
          key,
          type: "step",
          phase: this.phase,
          seq,
          status: "running",
          attempts,
          startedAt,
          ...(isRetryLater ? {} : { error: serializeError(error), failedAt: this.now() }),
        })
        return delayMs
      }

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
        nextRunAt: this.now() + delayMs,
        ...(isRetryLater ? {} : { error: serializeError(error), failedAt: this.now() }),
      })

      const reason = isRetryLater ? error.reason : `${key} failed, retrying`
      this.yieldWithResume(delayMs, `step:${reason}`)
    }

    // Retry budget exhausted: the failure is settled (checkpointed) state.
    await this.failStep(key, storeKey, seq, error, attempts, startedAt)
    if (isRetryLater) {
      throw markStepFailure(new DurableRetriesExhaustedError(key, attempts, serializeError(error)))
    }
    throw markStepFailure(error)
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
    void this.emitEvent("step_failed", {
      message: `step ${key} failed terminally after ${attempts} attempt(s)`,
      step: key,
      stepAttempt: attempts,
      err: compactError(error),
    })
    await this.deps.store.saveStep(this.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.phase,
      seq,
      status: "failed",
      error: serializeError(error),
      attempts,
      startedAt,
      failedAt: this.now(),
    })
  }

  // -- Sleep ---------------------------------------------------------------

  async sleep(key: string, duration: DurationInput): Promise<void> {
    await this.sleepFor(key, parseDuration(duration))
  }

  async sleepUntil(key: string, date: Date | number): Promise<void> {
    const target = date instanceof Date ? date.getTime() : date
    await this.sleepFor(key, target - this.now())
  }

  private async sleepFor(key: string, delayMs: number): Promise<void> {
    const storeKey = this.storageKey(key)
    const now = this.now()

    if (this.mode === "settle" && this.phase === "main") {
      const existing = await this.deps.store.getStep(this.instanceId, storeKey)
      if (existing?.status === "completed") return
      throw new SettleIncompleteError(key)
    }

    const begin = await this.deps.store.beginStep(this.instanceId, storeKey, {
      key,
      type: "sleep",
      phase: this.phase,
      now,
      nextRunAt: now + Math.max(0, delayMs),
    })

    if (begin.kind === "missing" || begin.kind === "cancelled") {
      throw new DurableCancelledError(this.instanceId)
    }

    if (begin.kind === "existing") {
      const existing = begin.step
      // Replay of an elapsed sleep: fall through.
      if (existing.status === "completed") return
      const wakeAt = existing.nextRunAt ?? 0
      if (wakeAt > now) {
        // Woken early (crash re-delivery, stall takeover, promote): the sleep
        // has NOT elapsed — suspend again for the remainder. This is the fix
        // for the 0.1.x crash window where a sleep persisted as "completed"
        // before the suspension was scheduled, so a re-delivery skipped it.
        await this.waitOrYield("sleep", wakeAt - now, `sleep:${key}`)
      }
      await this.deps.store.updateStep(this.instanceId, storeKey, {
        status: "completed",
        completedAt: this.now(),
      })
      return
    }

    // Fresh sleep, persisted as `running` with its wake time.
    if (delayMs <= 0) {
      // Nothing to wait for — complete inline rather than suspending for 0ms.
      await this.deps.store.updateStep(this.instanceId, storeKey, {
        status: "completed",
        completedAt: now,
      })
      return
    }

    // Normal mode: unwinds the processor (completion happens on the resume
    // tick via the `existing` path above). Settle mode: rejected with a clear
    // "no sleeping during settlement" error.
    await this.waitOrYield("sleep", delayMs, `sleep:${key}`)
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
    const inStep = currentStep.getStore()
    await this.writeLog({
      message,
      timestamp: this.now(),
      kind: "log",
      runCount: this.runCount,
      ...(this.deps.jobAttempt !== undefined ? { jobAttempt: this.deps.jobAttempt } : {}),
      ...(inStep ? { step: inStep.key, stepAttempt: inStep.attempt } : {}),
      ...(this.phase !== "main" ? { phase: this.phase } : {}),
      ...(meta ? { meta } : {}),
    })
  }

  /** Runtime-facing: append a failure-path event entry. */
  async emitEvent(
    event: DurableLogEvent,
    fields: Partial<DurableLogEntry> & { message: string },
  ): Promise<void> {
    await this.writeLog({
      timestamp: this.now(),
      kind: "event",
      event,
      runCount: this.runCount,
      ...(this.deps.jobAttempt !== undefined ? { jobAttempt: this.deps.jobAttempt } : {}),
      ...(this.phase !== "main" ? { phase: this.phase } : {}),
      ...fields,
    })
  }

  /**
   * Best-effort write to the job log — logging must never break execution, and
   * in cancel/cleanup races the job may already be gone.
   */
  private async writeLog(entry: DurableLogEntry): Promise<void> {
    if (!this.deps.job) return
    try {
      await this.deps.job.log(serializeLogEntry(entry))
    } catch {
      // ignore
    }
  }

  stepId(key: string): string {
    return stepIdOf(this.instanceId, key)
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Suspend for `delayMs`: in normal mode, record the resume and unwind the
   * processor with a {@link DurableYieldError} (the runtime turns it into
   * `moveToDelayed` on the run's job). In settle mode there is no job — a
   * backoff waits in-process (settlement work is compensation-sized), while a
   * sleep is rejected rather than silently blocking.
   */
  private async waitOrYield(
    kind: "sleep" | "backoff",
    delayMs: number,
    reason: string,
  ): Promise<void> {
    if (this.mode === "settle") {
      if (kind === "sleep") {
        throw new Error(
          "bullmq-durable: ctx.sleep is not supported during stall settlement — " +
            "settlement compensations must not sleep",
        )
      }
      await sleepInProcess(delayMs)
      return
    }
    this.yieldWithResume(delayMs, reason)
  }

  /**
   * Record the resume request, then unwind the processor with a
   * {@link DurableYieldError}. Concurrent yields keep the EARLIEST due time.
   * Never returns.
   */
  private yieldWithResume(delayMs: number, reason: string): never {
    if (this.mode === "settle") {
      throw new Error(
        "bullmq-durable: cannot suspend during stall settlement (no job to delay)",
      )
    }
    if (!this.pendingResume || delayMs < this.pendingResume.delayMs) {
      this.pendingResume = { delayMs, reason }
    }
    throw new DurableYieldError(reason)
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

function compactError(error: unknown): { name: string; message: string } {
  const s = serializeError(error)
  return { name: s.name, message: s.message }
}

function sleepInProcess(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
