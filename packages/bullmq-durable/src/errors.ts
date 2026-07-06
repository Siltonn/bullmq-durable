/**
 * Every error bullmq-durable throws, in three layers plus one marker:
 *
 *  - **Control-flow signals** (extend {@link DurableError}) — interpreted by
 *    the runtime inside a tick, never seen by BullMQ: yield, retry-later,
 *    non-retryable, cancellation, retries-exhausted, settlement-incomplete.
 *  - **Boundary errors** — thrown from the BullMQ processor wrapper so the job
 *    lands in the right BullMQ state. These extend BullMQ's
 *    `UnrecoverableError` (a hard requirement — BullMQ matches on it to skip
 *    further attempts), so they are the one branch of the family that cannot
 *    extend {@link DurableError}.
 *  - **Action errors** — thrown by `DurableRun` operations (dashboards / ops
 *    scripts), with a `code` that maps onto HTTP semantics.
 *  - **Step-failure marker** — an identity tag on errors that ARE a step's
 *    settled failure, so the runtime's two-budget classification never guesses.
 */

import { UnrecoverableError } from "bullmq"

/**
 * Base class for every durable-thrown error except the two BullMQ boundary
 * errors (which must extend `UnrecoverableError` instead — see above).
 */
export class DurableError extends Error {
  constructor(message: string) {
    super(message)
    // `new.target` resolves to the concrete subclass, giving each error a
    // correct `name` without repeating it in every constructor.
    this.name = new.target.name
  }
}

// ---------------------------------------------------------------------------
// Control-flow signals (runtime-internal; users only ever construct
// RetryLaterError / DurableNonRetryableError, via the ctx helpers)
// ---------------------------------------------------------------------------

/**
 * Internal signal thrown to unwind the processor when an instance yields
 * control (after `ctx.sleep`, a scheduled retry, or `ctx.retryLater`). The
 * worker catches this and treats the current tick as a successful no-op; a
 * delayed resume has already been scheduled.
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

/**
 * Internal signal: a stall-settlement replay hit a step that never completed.
 * The runtime routes this into the failure sequence with the settlement's
 * triggering error — the half-dead run must not execute new side effects.
 */
export class SettleIncompleteError extends DurableError {
  constructor(readonly stepKey: string) {
    super(`settlement replay reached incomplete step "${stepKey}"`)
  }
}

// ---------------------------------------------------------------------------
// Boundary errors (runtime → BullMQ; extend UnrecoverableError by necessity)
// ---------------------------------------------------------------------------

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
    markBoundaryError(this)
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
    markBoundaryError(this)
  }
}

/**
 * Identity marker for the two boundary errors, registered via `Symbol.for` so
 * it survives duplicated module instances (CJS/ESM dual package, two copies in
 * node_modules) — the same trick as the step-failure marker below.
 */
const BOUNDARY_ERROR_MARKER = Symbol.for("bullmq-durable:boundary-error")

function markBoundaryError(error: Error): void {
  Object.defineProperty(error, BOUNDARY_ERROR_MARKER, { value: true, configurable: true })
}

/**
 * Whether an error is one of OUR boundary errors — robust across duplicated
 * module instances, where `instanceof` silently fails: the symbol marker and
 * the class-name fallback both survive a second bullmq-durable copy.
 *
 * (BullMQ's own attempts-skip check is `instanceof UnrecoverableError || name
 * === "UnrecoverableError"` — under a duplicated *bullmq* copy it may retry a
 * settled run and burn attempts. That is bounded waste, not a correctness
 * problem: replays are idempotent and re-land on the stored terminal outcome,
 * and the `failed`-listener's terminal-status check stops double settlement.)
 */
export function isDurableBoundaryError(error: unknown): boolean {
  if (error instanceof DurableTerminalJobError || error instanceof DurableCancelledJobError) {
    return true
  }
  if (error === null || typeof error !== "object") return false
  if ((error as Record<symbol, unknown>)[BOUNDARY_ERROR_MARKER] === true) return true
  return (
    error instanceof Error &&
    (error.name === "DurableTerminalJobError" || error.name === "DurableCancelledJobError")
  )
}

// ---------------------------------------------------------------------------
// Action errors (DurableRun operations)
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link DurableRun} actions (resume/retry/retryCompensation/
 * cancel/delete); `code` maps cleanly onto HTTP semantics.
 */
export class DurableActionError extends DurableError {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_state",
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Step-failure marker
// ---------------------------------------------------------------------------

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
