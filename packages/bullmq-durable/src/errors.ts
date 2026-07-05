/**
 * Error types used for durable control flow.
 *
 * Two layers:
 *  - *Inner* signals interpreted by the runtime, never seen by BullMQ
 *    (`DurableYieldError`, `RetryLaterError`, `DurableCancelledError`,
 *    `DurableNonRetryableError`, `DurableRetriesExhaustedError`).
 *  - *Boundary* errors thrown from the BullMQ processor wrapper so the job
 *    lands in the right BullMQ state (`DurableTerminalJobError`,
 *    `DurableCancelledJobError` — both `UnrecoverableError`, so BullMQ never
 *    burns `attempts` re-delivering a run whose outcome is already settled).
 */

import { UnrecoverableError } from "bullmq"

/** Base class for every error raised by bullmq-durable. */
export class DurableError extends Error {
  constructor(message: string) {
    super(message)
    // `new.target` resolves to the concrete subclass, giving each error a
    // correct `name` without repeating it in every constructor.
    this.name = new.target.name
  }
}

/**
 * Internal signal thrown to unwind the processor when an instance yields
 * control (after `ctx.sleep`, a scheduled retry, or `ctx.retryLater`). The
 * worker catches this and treats the current tick as a successful no-op; a
 * delayed resume job has already been scheduled.
 *
 * Users should never throw this directly.
 */
export class DurableYieldError extends DurableError {
  constructor(readonly reason: string = "yield") {
    super(`Durable execution yielded: ${reason}`)
  }
}

/**
 * Thrown from inside a step to ask the runtime to retry that step later,
 * typically while polling a third-party provider. Behaves like a retryable
 * failure but is "expected" and is not recorded as an error when attempts
 * remain.
 *
 * Construct via `ctx.retryLater(...)` rather than `new`.
 */
export class RetryLaterError extends DurableError {
  constructor(
    /** Explicit delay before the next attempt (ms). Falls back to the step's retry delay. */
    readonly delayMs?: number,
    readonly reason: string = "retry later",
  ) {
    super(reason)
  }
}

/**
 * Thrown from inside a step to fail the whole instance immediately, bypassing
 * any remaining retry attempts. Construct via `ctx.nonRetryable(...)`.
 */
export class DurableNonRetryableError extends DurableError {
  constructor(reason: string) {
    super(reason)
  }
}

/** Raised when work is attempted on an instance that has been cancelled. */
export class DurableCancelledError extends DurableError {
  constructor(readonly instanceId: string) {
    super(`Durable instance "${instanceId}" was cancelled`)
  }
}

/** Raised when a step exhausts its retry budget without succeeding. */
export class DurableRetriesExhaustedError extends DurableError {
  constructor(
    readonly stepKey: string,
    readonly attempts: number,
    /** The underlying serialized error from the final attempt, if any. */
    override readonly cause?: unknown,
  ) {
    super(`Step "${stepKey}" failed after ${attempts} attempt(s)`)
  }
}

/** Raised when a durable operation exceeds its configured timeout. */
export class DurableTimeoutError extends DurableError {
  constructor(message: string) {
    super(message)
  }
}

/**
 * Boundary error: the durable run reached a terminal failure (compensation and
 * `onFailure` have already run — or the instance was already terminally failed
 * and a stray delivery replayed the stored error). Extends BullMQ's
 * `UnrecoverableError` so the job fails WITHOUT consuming further attempts:
 * every step failure is checkpointed and would replay identically, so a BullMQ
 * retry could never change the outcome.
 */
export class DurableTerminalJobError extends UnrecoverableError {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * Boundary error: the run was cancelled while its job was active. Thrown from
 * the processor wrapper so the job lands in `failed` (reason "cancelled")
 * instead of fake-completing. Extends `UnrecoverableError` — a cancelled run
 * must not be retried by BullMQ.
 */
export class DurableCancelledJobError extends UnrecoverableError {
  constructor(readonly instanceId: string) {
    super(`Durable instance "${instanceId}" was cancelled`)
    this.name = new.target.name
  }
}

/**
 * Marker for errors that ARE a step's settled failure (retry budget spent, or
 * a cached failure replayed). The runtime classifies on this identity instead
 * of guessing from context state: if user code catches a step failure,
 * recovers, and a DIFFERENT error later escapes the tick, that error carries
 * no marker and correctly rides the job-level retry budget. Registered via
 * `Symbol.for` so the check survives duplicated module instances.
 */
const STEP_FAILURE_MARKER = Symbol.for("bullmq-durable:step-failure")

/** Tag an error as a settled step failure (no-op for primitives). */
export function markStepFailure<T>(error: T): T {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, STEP_FAILURE_MARKER, { value: true, configurable: true })
    } catch {
      // frozen error object — classification degrades to job-level retries
    }
  }
  return error
}

/** Whether an error is a settled step failure (see {@link markStepFailure}). */
export function isStepFailure(error: unknown): boolean {
  return (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    (error as Record<symbol, unknown>)[STEP_FAILURE_MARKER] === true
  )
}

/** Type guard for the internal yield signal. */
export function isYieldError(error: unknown): error is DurableYieldError {
  return error instanceof DurableYieldError
}

/** Type guard for the retry-later signal. */
export function isRetryLaterError(error: unknown): error is RetryLaterError {
  return error instanceof RetryLaterError
}

/**
 * Type guard for *any* durable control-flow signal — yield, retry-later, or
 * cancellation. None of these are real failures: they are interpreted by the
 * runtime, not settled as errors. Use it to re-throw signals from a `catch`
 * without having to remember every variant (forgetting `DurableCancelledError`
 * is a common footgun that makes a cancelled job run its failure settlement).
 */
export function isDurableControlSignal(error: unknown): boolean {
  return (
    error instanceof DurableYieldError ||
    error instanceof RetryLaterError ||
    error instanceof DurableCancelledError
  )
}
