/**
 * The durable execution context (`ctx`) handed to processors — a thin facade.
 *
 * The real machinery lives in three focused collaborators:
 *  - {@link StepExecutor} (`step-executor.ts`) — the step state machine:
 *    replay, begin, retry loop, sleep-as-a-step, rollbacks, failed-step marking;
 *  - {@link SuspensionController} (`suspension.ts`) — the single owner of the
 *    "we must wait" decision (yield to BullMQ vs. in-process settlement wait);
 *  - `phase.ts` — phase-namespaced storage keys.
 *
 * What remains here is the user-facing surface (`step` / `sleep` / `log` /
 * `retryLater` / `nonRetryable`), in-flight step tracking for quiescence, and
 * durable log writing.
 */

import { DurableNonRetryableError, RetryLaterError } from "../errors"
import { activeStepInfo, StepExecutor } from "./step-executor"
import type { StateStore } from "../store/state-store"
import { SuspensionController, type PendingResume, type RunMode } from "./suspension"
import type {
  DurableContext,
  DurableLogEntry,
  DurableLogEvent,
  StepFn,
  StepOptions,
  StepPhase,
} from "../types"
import { type DurationInput, hasExplicitDurationUnit, parseDuration } from "../utils/duration"
import { stepIdOf } from "../utils/keys"
import { serializeLogEntry } from "../utils/log"

export type { RegisteredRollback } from "./step-executor"
export type { PendingResume, RunMode } from "./suspension"

/** Minimal surface used to write durable logs onto the BullMQ job. */
export interface JobLogSink {
  log(message: string): Promise<unknown>
}

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

export class DurableContextImpl implements DurableContext {
  readonly instanceId: string
  readonly runCount: number

  private readonly suspension: SuspensionController
  private readonly steps: StepExecutor

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
    this.suspension = new SuspensionController(deps.mode ?? "normal")
    this.steps = new StepExecutor({
      instanceId: deps.instanceId,
      store: deps.store,
      mode: deps.mode ?? "normal",
      suspension: this.suspension,
      ...(deps.defaultStepOptions !== undefined
        ? { defaultStepOptions: deps.defaultStepOptions }
        : {}),
      now: () => this.now(),
      emitEvent: (event, fields) => this.emitEvent(event, fields),
    })
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now()
  }

  // -- Runtime-facing surface (delegation) -----------------------------------

  /** Hand the recorded resume request (if any) to the runtime, clearing it. */
  takePendingResume(): PendingResume | undefined {
    return this.suspension.takePendingResume()
  }

  /** Switch the active phase. Used by the runtime to drive compensation/failure. */
  setPhase(phase: StepPhase): void {
    this.steps.setPhase(phase)
  }

  /** Compensations registered so far (call order), snapshotted for the runtime. */
  takeRollbacks(): ReturnType<StepExecutor["takeRollbacks"]> {
    return this.steps.takeRollbacks()
  }

  /** The main-phase step whose failure triggered the terminal sequence, if any. */
  get lastFailedStep(): string | undefined {
    return this.steps.lastFailedStep
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

  // -- Steps -------------------------------------------------------------------

  step<T>(key: string, fn: StepFn<T>): Promise<T>
  step<T>(key: string, options: StepOptions<T>, fn: StepFn<T>): Promise<T>
  async step<T>(
    key: string,
    optionsOrFn: StepOptions<T> | StepFn<T>,
    maybeFn?: StepFn<T>,
  ): Promise<T> {
    const { options, fn } = normalizeStepArgs<T>(optionsOrFn, maybeFn)
    const promise = this.steps.execute(key, options, fn)
    this.inFlight.add(promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(promise)
    }
  }

  // -- Sleep ---------------------------------------------------------------

  async sleep(key: string, duration: DurationInput): Promise<void> {
    await this.steps.sleepFor(key, parseDuration(duration))
  }

  async sleepUntil(key: string, date: Date | number): Promise<void> {
    const target = date instanceof Date ? date.getTime() : date
    await this.steps.sleepFor(key, target - this.now())
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
    const inStep = activeStepInfo()
    await this.writeLog({
      message,
      timestamp: this.now(),
      kind: "log",
      runCount: this.runCount,
      ...(this.deps.jobAttempt !== undefined ? { jobAttempt: this.deps.jobAttempt } : {}),
      ...(inStep ? { step: inStep.key, stepAttempt: inStep.attempt } : {}),
      ...(this.steps.phase !== "main" ? { phase: this.steps.phase } : {}),
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
      ...(this.steps.phase !== "main" ? { phase: this.steps.phase } : {}),
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
