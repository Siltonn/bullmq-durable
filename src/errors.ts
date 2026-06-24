/**
 * Error types used for durable control flow.
 *
 * Some of these are genuine failures (`DurableNonRetryableError`,
 * `DurableTimeoutError`) while others are *control-flow signals* that the
 * runtime interprets rather than treats as failures (`DurableYieldError`,
 * `RetryLaterError`, `DurableCancelledError`).
 */

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

/** Type guard for the internal yield signal. */
export function isYieldError(error: unknown): error is DurableYieldError {
  return error instanceof DurableYieldError
}

/** Type guard for the retry-later signal. */
export function isRetryLaterError(error: unknown): error is RetryLaterError {
  return error instanceof RetryLaterError
}
