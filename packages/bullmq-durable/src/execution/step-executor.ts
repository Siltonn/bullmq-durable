/**
 * {@link StepExecutor} — the step state machine behind `ctx.step` / `ctx.sleep`:
 * replay, begin, the retry loop, sleep-as-a-durable-step, rollback registration
 * and failed-step marking.
 *
 * The mode/phase forks are NAMED decisions instead of inline checks:
 *  - {@link isSettlementMainReplay} → `replaySettlementMain*` — a settlement
 *    tick replays the forward phase read-only (register rollbacks from
 *    completed steps, stop at the first incomplete one; no new side effects on
 *    a run whose job already failed);
 *  - {@link shouldRetryInProcess} → `recordRetryForSettlement` vs.
 *    `recordRetryAndYield` — a retryable failure either waits in-process
 *    (settlement has no job to delay) or persists `nextRunAt` and yields.
 *
 * All waiting is delegated to the {@link SuspensionController}.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import {
  DurableCancelledError,
  DurableNonRetryableError,
  DurableRetriesExhaustedError,
  DurableYieldError,
  markStepFailure,
  RetryLaterError,
  SettleIncompleteError,
} from "../errors"
import { storageKeyForPhase } from "./phase"
import type { StateStore } from "../store/state-store"
import type {
  DurableLogEntry,
  DurableLogEvent,
  RetryOptions,
  RollbackFn,
  StepFn,
  StepOptions,
  StepPhase,
} from "../types"
import { computeBackoff, resolveRetry } from "../utils/retry"
import { cloneValue, deserializeError, serializeError } from "../utils/serialize"
import type { RunMode, SuspensionController } from "./suspension"

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

/** Everything the executor borrows from its context facade. */
export interface StepExecutorDeps {
  instanceId: string
  store: StateStore
  mode: RunMode
  suspension: SuspensionController
  defaultStepOptions?: StepOptions
  /** Injectable time source (virtual clocks in tests). */
  now(): number
  /** Failure-path event sink (`step_retry` / `step_failed` log lines). */
  emitEvent(
    event: DurableLogEvent,
    fields: Partial<DurableLogEntry> & { message: string },
  ): Promise<void>
}

/** Tracks which step (and attempt) is executing, across concurrent steps. */
const currentStep = new AsyncLocalStorage<{ key: string; attempt: number }>()

/** The step/attempt the calling code is inside of, if any (log attribution). */
export function activeStepInfo(): { key: string; attempt: number } | undefined {
  return currentStep.getStore()
}

/** The begin outcome of a writable step: a replayed value, or a live attempt. */
type WritableBegin<T> =
  | { kind: "replayed"; value: T }
  | { kind: "attempt"; attempts: number; seq: number; startedAt: number }

export class StepExecutor {
  /**
   * The lifecycle phase of the steps being run right now. The runtime flips
   * this to drive compensation / failure-handling against the same machinery.
   * Phase is purely a storage namespace — see `phase.ts`.
   */
  private activePhase: StepPhase = "main"

  /**
   * Compensations registered by completed steps during this tick's replay, in
   * call order. Only the in-memory closures here are runnable — the store keeps
   * step state/output, not functions — so compensation must run on the tick that
   * replayed them. See the runtime's failure sequence.
   */
  private readonly rollbacks: RegisteredRollback[] = []

  /** The (raw) key of the main-phase step whose failure triggered terminal-ness. */
  private failedStepKey?: string

  constructor(private readonly deps: StepExecutorDeps) {}

  get phase(): StepPhase {
    return this.activePhase
  }

  /** Switch the active phase. Used by the runtime to drive compensation/failure. */
  setPhase(phase: StepPhase): void {
    this.activePhase = phase
  }

  /** Compensations registered so far (call order), snapshotted for the runtime. */
  takeRollbacks(): RegisteredRollback[] {
    return [...this.rollbacks]
  }

  /** The main-phase step whose failure triggered the terminal sequence, if any. */
  get lastFailedStep(): string | undefined {
    return this.failedStepKey
  }

  // -- Steps -----------------------------------------------------------------

  async execute<T>(key: string, options: StepOptions<T>, fn: StepFn<T>): Promise<T> {
    if (this.isSettlementMainReplay()) {
      return this.replaySettlementMainStep(key, options)
    }
    return this.executeWritableStep(key, options, fn)
  }

  /** A settlement tick's forward phase is replay-only — never a writer. */
  private isSettlementMainReplay(): boolean {
    return this.deps.mode === "settle" && this.activePhase === "main"
  }

  /**
   * Read-only replay for settlement: completed steps register their rollbacks
   * and return the checkpoint; a failed step re-throws its settled failure;
   * the first incomplete step ends the replay ({@link SettleIncompleteError} —
   * the half-dead run must not execute new side effects).
   */
  private async replaySettlementMainStep<T>(key: string, options: StepOptions<T>): Promise<T> {
    const existing = await this.deps.store.getStep(this.deps.instanceId, this.storageKey(key))
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

  private async executeWritableStep<T>(
    key: string,
    options: StepOptions<T>,
    fn: StepFn<T>,
  ): Promise<T> {
    const begin = await this.beginOrReplayWritableStep<T>(key, options)
    if (begin.kind === "replayed") return begin.value
    return this.runStepAttemptLoop(key, begin, options, fn)
  }

  /**
   * Resolve the step's persisted state into either a replayed value or a live
   * attempt: fresh steps come back `running` from `beginStep`; completed steps
   * replay their checkpoint; failed steps replay their error (symmetric — a
   * settled failure's side effect must not re-fire on later resumes); a
   * `running` record with a future `nextRunAt` honours the persisted backoff
   * first (an early re-delivery must not run the attempt ahead of schedule).
   */
  private async beginOrReplayWritableStep<T>(
    key: string,
    options: StepOptions<T>,
  ): Promise<WritableBegin<T>> {
    const storeKey = this.storageKey(key)
    const now = this.deps.now()
    const begin = await this.deps.store.beginStep(this.deps.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.activePhase,
      now,
    })

    if (begin.kind === "missing" || begin.kind === "cancelled") {
      throw new DurableCancelledError(this.deps.instanceId)
    }

    if (begin.kind === "created") {
      // Fresh step: beginStep already persisted the `running` record.
      return { kind: "attempt", attempts: 1, seq: begin.seq, startedAt: now }
    }

    const existing = begin.step
    if (existing.status === "completed") {
      // Replay: return the checkpointed result without re-running the body.
      // The rollback closure is re-registered from the CURRENT code's options.
      this.registerRollback(key, existing.seq ?? 0, existing.result, options)
      return { kind: "replayed", value: existing.result as T }
    }
    if (existing.status === "failed") {
      if (this.activePhase === "main") this.failedStepKey = key
      throw markStepFailure(
        deserializeError(existing.error ?? { name: "Error", message: `Step "${key}" failed` }),
      )
    }

    // `running` — a scheduled retry, or crash recovery mid-attempt.
    if (existing.nextRunAt !== undefined && existing.nextRunAt > now) {
      await this.deps.suspension.waitOrYield(
        "backoff",
        existing.nextRunAt - now,
        `step:${key} backoff`,
      )
    }
    const attempt = {
      kind: "attempt" as const,
      attempts: existing.attempts + 1,
      seq: existing.seq ?? 0,
      startedAt: existing.startedAt ?? now,
    }
    // Full-state write: clears any stale nextRunAt for the new attempt.
    await this.saveRunning(key, storeKey, attempt.seq, attempt.attempts, attempt.startedAt)
    return attempt
  }

  /** Run the body until it checkpoints, fails terminally, or yields. */
  private async runStepAttemptLoop<T>(
    key: string,
    attempt: { attempts: number; seq: number; startedAt: number },
    options: StepOptions<T>,
    fn: StepFn<T>,
  ): Promise<T> {
    const storeKey = this.storageKey(key)
    let { attempts } = attempt
    const { seq, startedAt } = attempt

    for (;;) {
      try {
        const result = await currentStep.run({ key, attempt: attempts }, () => fn())
        // Persist and return the *cloned* result so the first run observes exactly
        // what a later replay would: a store round-trip is a JSON round-trip, which
        // turns Dates into strings, drops `undefined`, etc. Returning the live value
        // here would let code work on the first tick and crash on resume.
        const checkpointed = cloneValue(result)
        await this.deps.store.saveStep(this.deps.instanceId, storeKey, {
          key,
          type: "step",
          phase: this.activePhase,
          seq,
          status: "completed",
          result: checkpointed,
          attempts,
          startedAt,
          completedAt: this.deps.now(),
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
        // Reached only when the failure was recorded for an in-process retry
        // (settlement): wait out the backoff, then run the next attempt.
        await this.deps.suspension.waitOrYield("backoff", retryDelayMs, `step:${key} retry`)
        attempts += 1
        await this.saveRunning(key, storeKey, seq, attempts, startedAt)
      }
    }
  }

  /**
   * Decide what to do when a step body throws. On the normal path this never
   * returns: it either yields (retry scheduled via the job's own delay), or
   * fails the step and rethrows. When retrying in-process (settlement) it
   * RETURNS the backoff delay for the attempt loop to wait out.
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
      isRetryLater && attemptsConfigured === undefined && this.deps.mode === "normal"
        ? Number.POSITIVE_INFINITY
        : retry.attempts

    if (attempts < maxAttempts) {
      const delayMs =
        isRetryLater && error.delayMs !== undefined ? error.delayMs : computeBackoff(retry, attempts)

      if (!isRetryLater) {
        void this.deps.emitEvent("step_retry", {
          message: `step ${key} attempt ${attempts}/${maxAttempts} failed, retry in ${delayMs}ms`,
          step: key,
          stepAttempt: attempts,
          err: compactError(error),
          retryInMs: delayMs,
        })
      }

      if (this.shouldRetryInProcess()) {
        return this.recordRetryForSettlement(key, storeKey, seq, error, isRetryLater, {
          attempts,
          startedAt,
          delayMs,
        })
      }
      return this.recordRetryAndYield(key, storeKey, seq, error, isRetryLater, {
        attempts,
        startedAt,
        delayMs,
      })
    }

    // Retry budget exhausted: the failure is settled (checkpointed) state.
    await this.failStep(key, storeKey, seq, error, attempts, startedAt)
    if (isRetryLater) {
      throw markStepFailure(new DurableRetriesExhaustedError(key, attempts, serializeError(error)))
    }
    throw markStepFailure(error)
  }

  /** Settlement retries wait in-process — there is no job left to delay. */
  private shouldRetryInProcess(): boolean {
    return this.deps.mode === "settle"
  }

  /** Record the failure for observability, then hand the delay to the loop. */
  private async recordRetryForSettlement(
    key: string,
    storeKey: string,
    seq: number,
    error: unknown,
    isRetryLater: boolean,
    state: { attempts: number; startedAt: number; delayMs: number },
  ): Promise<number> {
    await this.deps.store.saveStep(this.deps.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.activePhase,
      seq,
      status: "running",
      attempts: state.attempts,
      startedAt: state.startedAt,
      ...(isRetryLater ? {} : { error: serializeError(error), failedAt: this.deps.now() }),
    })
    return state.delayMs
  }

  /** Persist the scheduled retry (`nextRunAt`), then yield the tick. */
  private async recordRetryAndYield(
    key: string,
    storeKey: string,
    seq: number,
    error: unknown,
    isRetryLater: boolean,
    state: { attempts: number; startedAt: number; delayMs: number },
  ): Promise<never> {
    await this.deps.store.saveStep(this.deps.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.activePhase,
      seq,
      // Stays "running": the step is mid-flight and will resume. We only
      // record an `error` for genuine failures, not expected retry-later.
      status: "running",
      attempts: state.attempts,
      startedAt: state.startedAt,
      nextRunAt: this.deps.now() + state.delayMs,
      ...(isRetryLater ? {} : { error: serializeError(error), failedAt: this.deps.now() }),
    })
    const reason = isRetryLater ? (error as RetryLaterError).reason : `${key} failed, retrying`
    this.deps.suspension.yieldToBullMQ(state.delayMs, `step:${reason}`)
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
    if (this.activePhase === "main") this.failedStepKey = key
    void this.deps.emitEvent("step_failed", {
      message: `step ${key} failed terminally after ${attempts} attempt(s)`,
      step: key,
      stepAttempt: attempts,
      err: compactError(error),
    })
    await this.deps.store.saveStep(this.deps.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.activePhase,
      seq,
      status: "failed",
      error: serializeError(error),
      attempts,
      startedAt,
      failedAt: this.deps.now(),
    })
  }

  // -- Sleep (a durable step of type "sleep") ---------------------------------

  async sleepFor(key: string, delayMs: number): Promise<void> {
    if (this.isSettlementMainReplay()) {
      return this.replaySettlementMainSleep(key)
    }

    const storeKey = this.storageKey(key)
    const now = this.deps.now()
    const begin = await this.deps.store.beginStep(this.deps.instanceId, storeKey, {
      key,
      type: "sleep",
      phase: this.activePhase,
      now,
      nextRunAt: now + Math.max(0, delayMs),
    })

    if (begin.kind === "missing" || begin.kind === "cancelled") {
      throw new DurableCancelledError(this.deps.instanceId)
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
        await this.deps.suspension.waitOrYield("sleep", wakeAt - now, `sleep:${key}`)
      }
      await this.deps.store.updateStep(this.deps.instanceId, storeKey, {
        status: "completed",
        completedAt: this.deps.now(),
      })
      return
    }

    // Fresh sleep, persisted as `running` with its wake time.
    if (delayMs <= 0) {
      // Nothing to wait for — complete inline rather than suspending for 0ms.
      await this.deps.store.updateStep(this.deps.instanceId, storeKey, {
        status: "completed",
        completedAt: now,
      })
      return
    }

    // Normal mode: unwinds the processor (completion happens on the resume
    // tick via the `existing` path above). Settle mode: rejected with a clear
    // "no sleeping during settlement" error.
    await this.deps.suspension.waitOrYield("sleep", delayMs, `sleep:${key}`)
  }

  /** Settlement replay of a sleep: elapsed → skip; pending → replay is over. */
  private async replaySettlementMainSleep(key: string): Promise<void> {
    const existing = await this.deps.store.getStep(this.deps.instanceId, this.storageKey(key))
    if (existing?.status === "completed") return
    throw new SettleIncompleteError(key)
  }

  // -- Internals ---------------------------------------------------------------

  private storageKey(key: string): string {
    return storageKeyForPhase(this.activePhase, key)
  }

  /** Record a completed step's `onRollback` closure (main phase only). */
  private registerRollback(
    key: string,
    seq: number,
    output: unknown,
    options: StepOptions<any>,
  ): void {
    if (this.activePhase !== "main" || !options.onRollback) return
    const onRb = options.onRollback
    const handler = (typeof onRb === "function" ? onRb : onRb.handler) as RollbackFn<unknown>
    const retry = typeof onRb === "function" ? undefined : onRb.retry
    this.rollbacks.push({ key, seq, output, handler, retry })
  }

  private async saveRunning(
    key: string,
    storeKey: string,
    seq: number,
    attempts: number,
    startedAt: number,
  ): Promise<void> {
    await this.deps.store.saveStep(this.deps.instanceId, storeKey, {
      key,
      type: "step",
      phase: this.activePhase,
      seq,
      status: "running",
      attempts,
      startedAt,
    })
  }
}

function compactError(error: unknown): { name: string; message: string } {
  const s = serializeError(error)
  return { name: s.name, message: s.message }
}
