/**
 * Public type definitions for bullmq-durable.
 *
 * This module is intentionally free of runtime code so it can be imported from
 * anywhere without side effects.
 */

import type { Job, Queue as BullQueue, QueueOptions, WorkerOptions } from "bullmq"
import type { DurableNonRetryableError, RetryLaterError } from "./errors"
import type { StateStore } from "./store/state-store"
import type { DurationInput } from "./utils/duration"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A plain, JSON-serialisable representation of a thrown error. */
export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string | number
}

// ---------------------------------------------------------------------------
// Retry / step configuration
// ---------------------------------------------------------------------------

/** Built-in backoff strategies, mirroring BullMQ's `BackoffOptions.type`. */
export type BackoffType = "fixed" | "exponential"

/**
 * Backoff between step retries, shaped like BullMQ's `backoff` option so the
 * two read identically:
 *
 *  - a number or duration string (`5000`, `"5s"`) — fixed delay;
 *  - `{ type, delay, jitter, maxDelay }` — the BullMQ `BackoffOptions` shape,
 *    with durable extensions: `delay`/`maxDelay` accept duration strings, and
 *    `maxDelay` caps exponential growth (defaults to 1 hour — BullMQ has no
 *    cap, but an uncapped step backoff would push resumes absurdly far out).
 *
 * `jitter` (0..1) spreads the delay uniformly over `[delay*(1-jitter), delay)`,
 * exactly like BullMQ's built-in strategies.
 *
 * A bare `"fixed"` / `"exponential"` string is the deprecated 0.1.x form (its
 * base delay came from the sibling `delay` field); it is still accepted and
 * normalised, but prefer the object form.
 */
export type StepBackoff =
  | number
  | DurationInput
  | BackoffType
  | {
      type?: BackoffType
      delay?: number | DurationInput
      /** Randomisation fraction (0..1), same semantics as BullMQ. */
      jitter?: number
      /** Durable extension: cap on the computed delay. Default `"1h"` for exponential. */
      maxDelay?: number | DurationInput
    }

/** Retry policy for a single step. Shaped after BullMQ's `attempts`/`backoff`. */
export interface RetryOptions {
  /** Maximum number of attempts (including the first). Defaults to `1`. */
  attempts?: number
  /** Backoff between attempts. Defaults to no delay. */
  backoff?: StepBackoff
  /**
   * @deprecated 0.1.x shape — base delay between attempts. Use
   * `backoff: { type, delay }` (or a bare number/duration) instead.
   */
  delay?: DurationInput
  /**
   * @deprecated 0.1.x shape — cap on the computed delay. Use
   * `backoff: { maxDelay }` instead.
   */
  maxDelay?: DurationInput
}

/**
 * A per-step compensation handler. Runs (in reverse order) when the instance
 * reaches a terminal failure, but only for steps that actually completed.
 * `output` is the step's checkpoint snapshot (same JSON-roundtripped value the
 * step returned); `error` is the error that triggered the terminal failure.
 *
 * Compensations MUST be idempotent — they run as durable, retried steps and may
 * re-run across resumes. Use `ctx.stepId(key)` as a business idempotency key.
 */
export type RollbackFn<T> = (rb: { output: T; error: unknown }) => void | Promise<void>

/** Options accepted by `ctx.step(key, options, fn)`. */
export interface StepOptions<T = unknown> {
  /** Retry policy for this step. */
  retry?: RetryOptions
  /**
   * Compensation for this step, run in reverse order on terminal failure (only
   * if the step completed). A bare function uses the worker's
   * `defaultRollbackRetry`; the object form configures the compensation's own
   * retry policy.
   */
  onRollback?: RollbackFn<T> | { handler: RollbackFn<T>; retry?: RetryOptions }
}

// ---------------------------------------------------------------------------
// Step state machine
// ---------------------------------------------------------------------------

export type StepStatus = "running" | "completed" | "failed" | "sleeping" | "skipped"

export type StepType = "step" | "sleep"

/**
 * Which lifecycle phase a step belongs to. Orthogonal to {@link StepType}.
 * `main` is the forward processor; `compensation` is a per-step `onRollback`
 * (stored under the `__rollback__:` namespace); `failure` is a step run inside
 * the `onFailure` handler (stored under `__failure__:`). Absent means `main`.
 */
export type StepPhase = "main" | "compensation" | "failure"

/** Persisted state for a single step within an instance. */
export interface StepState {
  key: string
  type: StepType
  /** Lifecycle phase. Absent is treated as `"main"` (back-compat with 0.1.x). */
  phase?: StepPhase
  /**
   * Monotonic per-instance sequence, allocated once at the step's first persist
   * (reused on replay). It is the stable order key for compensation — rollbacks
   * run in reverse `seq` order (reverse of execution-start), which stays
   * deterministic across resumes even for steps started concurrently. Also gives
   * cockpit a collision-free step timeline.
   */
  seq?: number
  status: StepStatus
  /** Cached return value once `status === "completed"`. */
  result?: unknown
  /** Last failure, if any. */
  error?: SerializedError
  /** Number of times the step callback has been invoked so far. */
  attempts: number
  startedAt?: number
  completedAt?: number
  failedAt?: number
  /** When a retry/sleep is scheduled, the wall-clock time it should resume. */
  nextRunAt?: number
}

// ---------------------------------------------------------------------------
// Instance state machine
// ---------------------------------------------------------------------------

export type InstanceStatus =
  | "running"
  | "yielded"
  | "compensating"
  | "completed"
  | "failed"
  | "compensation_failed"
  | "cancelled"

/** A single compensation's outcome, surfaced to `onFailure` and to cockpit. */
export interface CompensationOutcome {
  key: string
  status: "rolled-back" | "failed" | "skipped"
  error?: SerializedError
}

/** Report of the compensation phase: what was rolled back, what failed. */
export interface CompensationReport {
  rolledBack: string[]
  failed: CompensationOutcome[]
}

/** Persisted state for a durable instance — the real unit of execution. */
export interface InstanceState {
  id: string
  queueName: string
  jobName: string
  /** The BullMQ job id of the run's (single) job. Stable for the whole run. */
  originalJobId: string
  status: InstanceStatus
  input: unknown
  output?: unknown
  error?: SerializedError
  /**
   * The error that triggered the `compensating` phase, persisted so a resumed
   * compensation tick can rebuild `DurableFailureInfo.error` without re-deriving
   * it from the failed step.
   */
  failureError?: SerializedError
  /** The key of the step whose failure triggered the terminal sequence. */
  failedStep?: string
  /** Compensation report, written when the instance reaches a terminal state. */
  compensation?: CompensationReport
  /** How many times the processor has been (re)entered for this instance. */
  runCount: number
  /**
   * @deprecated 0.1.x resume-job counter. Never written by 0.2.x; still parsed
   * so `cancel()` can find an in-flight legacy resume job during a rolling
   * upgrade. Removed in 0.3.0.
   */
  resumeSeq?: number
  /** Monotonic counter used to allocate per-step {@link StepState.seq}. */
  stepSeq?: number
  createdAt: number
  updatedAt: number
  completedAt?: number
  failedAt?: number
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/** Runtime-emitted log events (failure-path transitions only). */
export type DurableLogEvent = "step_retry" | "step_failed" | "comp_start" | "comp_step" | "settled"

/**
 * A structured durable log entry. Stored as one JSON line in the BullMQ job's
 * own log list (`job.log()`), tagged `"$durable": 1` on the wire so readers can
 * tell durable lines from foreign `job.log()` calls. Bounded by the job's
 * `keepLogs` option; removed together with the job.
 */
export interface DurableLogEntry {
  /** Human-readable text (present for every kind). */
  message: string
  /** Epoch ms — `job.log` has no native timestamp, so entries carry their own. */
  timestamp: number
  /**
   * `"log"` — user `ctx.log`; `"event"` — runtime failure-path event;
   * `"raw"` — a non-durable line found in the job log (returned by parsers,
   * never written by the runtime).
   */
  kind: "log" | "event" | "raw"
  /** Which delivery/tick of the run emitted this (1-based). */
  runCount?: number
  /** Which BullMQ attempt cycle (attemptsMade + 1; only real failures increment). */
  jobAttempt?: number
  /** Step key, when emitted inside a step (or an event about a step). */
  step?: string
  /** The step's attempt number at the time of the entry. */
  stepAttempt?: number
  /** Present outside the main phase. */
  phase?: Exclude<StepPhase, "main">
  /** Event code (kind === "event" only). */
  event?: DurableLogEvent
  /** Compact error info for events ({@link SerializedError} minus stack). */
  err?: { name: string; message: string }
  /** Delay before the next attempt, for retry events (ms). */
  retryInMs?: number
  /** User-supplied metadata (kind === "log" only). */
  meta?: Record<string, unknown>
}

/** @deprecated Renamed to {@link DurableLogEntry} in 0.2.0. */
export type DurableLog = DurableLogEntry

// ---------------------------------------------------------------------------
// Job typing
// ---------------------------------------------------------------------------

/**
 * A BullMQ {@link Job} augmented with its durable instance id. `data` is always
 * the plain user payload — a durable run rides a single BullMQ job for its
 * whole life, with no metadata envelope.
 */
export type DurableJob<Data = unknown, Result = unknown, Name extends string = string> = Job<
  Data,
  Result,
  Name
> & {
  /** The stable durable instance id backing this job. */
  readonly durableId: string
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** A step body. May be sync or async; its resolved value is checkpointed. */
export type StepFn<T> = () => T | Promise<T>

/**
 * The durable execution context handed to a processor as its second argument.
 *
 * Every method that touches the store is keyed by a *stable* string. Keys must
 * be deterministic across replays — do not derive them from timestamps or
 * random values.
 */
export interface DurableContext {
  /** The stable durable instance id. */
  readonly instanceId: string
  /** The current run/resume count for this instance (1 on the first tick). */
  readonly runCount: number

  /**
   * Run `fn` exactly once and checkpoint its result. On replay, a completed
   * step returns its cached result without re-running `fn`.
   */
  step<T>(key: string, fn: StepFn<T>): Promise<T>
  step<T>(key: string, options: StepOptions<T>, fn: StepFn<T>): Promise<T>

  /** Pause the instance for `duration` without occupying a worker. */
  sleep(key: string, duration: DurationInput): Promise<void>

  /** Pause the instance until a specific wall-clock time. */
  sleepUntil(key: string, date: Date | number): Promise<void>

  /** Build a `RetryLaterError` to throw from within a step. */
  retryLater(reason?: string): RetryLaterError
  retryLater(delay: DurationInput, reason?: string): RetryLaterError

  /** Build a `DurableNonRetryableError` that fails the instance immediately. */
  nonRetryable(reason: string): DurableNonRetryableError

  /**
   * Append a structured log line to the BullMQ job log. Entries are tagged with
   * the current run/step/attempt automatically; bounded by the job's `keepLogs`.
   */
  log(message: string, meta?: Record<string, unknown>): Promise<void>

  /** Deterministic id for a step, suitable as a business idempotency key. */
  stepId(key: string): string
}

// ---------------------------------------------------------------------------
// Processors
// ---------------------------------------------------------------------------

/** A processor for a single job type. */
export type DurableProcessor<TData = unknown, TResult = unknown, TName extends string = string> = (
  job: DurableJob<TData, TResult, TName>,
  ctx: DurableContext,
) => Promise<TResult> | TResult

/**
 * Structured information handed to an `onFailure` handler when an instance
 * reaches a terminal failure. Lets settlement branch on *what* happened without
 * hand-maintaining flags.
 */
export interface DurableFailureInfo {
  /** The error that triggered the terminal failure. */
  error: unknown
  /** The key of the step whose failure triggered it (if a step threw). */
  failedStep?: string
  /** Keys of the `main`-phase steps that completed (replaces `reserved`-style flags). */
  completed: ReadonlySet<string>
  /** Outcome of the compensation phase that ran before this handler. */
  compensation: CompensationReport
}

/**
 * A terminal-failure handler. Runs once, AFTER per-step compensation, only for
 * genuine failures — control-flow signals (yield / retryLater / cancel) never
 * reach it. Its own `ctx.step` calls are durable and idempotent.
 */
export type DurableFailureHandler<TData = unknown, TResult = unknown> = (
  job: DurableJob<TData, TResult>,
  ctx: DurableContext,
  failure: DurableFailureInfo,
) => Promise<void> | void

/**
 * A per-job handler: either a bare processor function, or an object pairing the
 * forward processor with a sibling `onFailure` settlement handler.
 */
export interface DurableJobHandler<
  TData = unknown,
  TResult = unknown,
  TName extends string = string,
> {
  run: DurableProcessor<TData, TResult, TName>
  onFailure?: DurableFailureHandler<TData, TResult>
}

/**
 * A map of job name -> processor (or `{ run, onFailure }`), for multi-job
 * workers. The job name is a free routing label (BullMQ-style); each handler
 * types its own payload through its `DurableJob<Data, Result>` parameter, so
 * there is no central name->payload map to declare.
 */
export type DurableProcessorHandlers = Record<
  string,
  DurableProcessor<any, any, string> | DurableJobHandler<any, any, string>
>

/**
 * The processor argument accepted by `DurableWorker`, in three forms:
 *
 *  1. a single function — handles every job name;
 *  2. a top-level `{ run, onFailure }` — the worker's default handler, for the
 *     common "one queue = one workflow" shape where the job name is just a
 *     label and `onFailure` belongs with the processor, not the options;
 *  3. a per-name handler map — multi-job workers.
 *
 * Disambiguation makes `run` a reserved word in the map form: an object whose
 * `run` property is a FUNCTION is read as form 2. A worker that really has a
 * job named `"run"` still works — use the object entry:
 * `{ run: { run: handleRunJob } }`.
 */
export type DurableProcessorInput =
  | DurableProcessor<any, any, string>
  | DurableJobHandler<any, any, string>
  | DurableProcessorHandlers

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * @deprecated Since 0.2.0 durable state follows its BullMQ job's lifetime
 * (`removeOnComplete` / `removeOnFail` govern the whole run; state is reclaimed
 * when the job disappears). The option is accepted and ignored. Removed in 0.3.0.
 */
export interface RetentionOptions {
  completed?: DurationInput
  failed?: DurationInput
  compensationFailed?: DurationInput
  cancelled?: DurationInput
}

/** @deprecated See {@link RetentionOptions}. Kept only so 0.1.x imports compile. */
export const DEFAULT_RETENTION: Required<RetentionOptions> = {
  completed: "24h",
  failed: "7d",
  compensationFailed: "30d",
  cancelled: "24h",
}

/**
 * Options for {@link DurableQueue}. Extends BullMQ's own `QueueOptions` — every
 * native option (`connection`, `prefix`, `defaultJobOptions`, …) passes through
 * untouched.
 */
export interface DurableQueueOptions extends QueueOptions {
  /** Custom state store. Defaults to a `RedisStateStore` built from `connection`. */
  stateStore?: StateStore
  /** Redis key prefix for durable state. Defaults to `"bullmq-durable"`. */
  durablePrefix?: string
  /**
   * Reuse an existing BullMQ `Queue` (same name) instead of opening a new one —
   * e.g. a dashboard that already holds one per queue. Ownership stays with
   * the caller: `DurableQueue.close()` will not close an injected queue.
   */
  bullmq?: BullQueue
  /** Tune the state reaper (state-follows-job collection). */
  reaper?: DurableReaperConfig
  /** @deprecated Renamed to `prefix` (BullMQ's own option). Removed in 0.3.0. */
  bullPrefix?: string
  /** @deprecated 0.2.0 has no resume jobs; accepted and ignored. Removed in 0.3.0. */
  resumeAttempts?: number
}

/**
 * Tuning for the state reaper — the observer that deletes durable state once
 * its BullMQ job is gone. Defaults suit most deployments; raise
 * `terminalBatchSize` when heavy `removeOn*` churn leaves large trails.
 */
export interface DurableReaperConfig {
  /** Oldest entries checked per done-bucket per pass. Default 32. */
  terminalBatchSize?: number
  /** Min interval between fire-and-forget reap passes. Default 5s (5_000). */
  throttleMs?: number
  /**
   * How long a non-terminal instance whose job is missing must stay quiet
   * before it is treated as an orphan and cancelled. Default 10s (10_000).
   */
  orphanGraceMs?: number
}

/**
 * Options for {@link DurableWorker}. Extends BullMQ's own `WorkerOptions` —
 * `concurrency`, `prefix`, `lockDuration`, `stalledInterval`, `maxStalledCount`,
 * `limiter`, `settings.backoffStrategy`, … all pass through untouched.
 */
export interface DurableWorkerOptions extends WorkerOptions {
  /** Custom state store. Defaults to a `RedisStateStore` built from `connection`. */
  stateStore?: StateStore
  /** Redis key prefix for durable state. Defaults to `"bullmq-durable"`. */
  durablePrefix?: string
  /** Tune the state reaper (state-follows-job collection). */
  reaper?: DurableReaperConfig
  /** Default step options merged into every `ctx.step` call. */
  defaultStepOptions?: StepOptions
  /**
   * Default retry policy for `onRollback` compensations that don't set their
   * own. Compensations should be tried hard before giving up. Defaults to
   * `{ attempts: 5, backoff: { type: "exponential", delay: "1s", maxDelay: "30s" } }`.
   */
  defaultRollbackRetry?: RetryOptions
  /**
   * A global terminal-failure handler applied to every job that doesn't supply
   * its own (via a `{ run, onFailure }` handler). Runs after compensation.
   */
  onFailure?: DurableFailureHandler
  /** @deprecated Renamed to `prefix` (BullMQ's own option). Removed in 0.3.0. */
  bullPrefix?: string
  /**
   * @deprecated The instance lock is internal since 0.2.0 (fixed 30s TTL with
   * renewal); tune BullMQ's own `lockDuration`/`stalledInterval` instead.
   * Accepted and ignored. Removed in 0.3.0.
   */
  lockTimeout?: DurationInput
  /** @deprecated See {@link RetentionOptions}. Accepted and ignored. Removed in 0.3.0. */
  retention?: RetentionOptions
  /**
   * @deprecated Logs live in the BullMQ job log since 0.2.0 — bound them with
   * `defaultJobOptions.keepLogs`. Accepted and ignored. Removed in 0.3.0.
   */
  maxLogs?: number
  /** @deprecated 0.2.0 has no resume jobs; accepted and ignored. Removed in 0.3.0. */
  resumeAttempts?: number
  /**
   * @deprecated Options now ARE BullMQ `WorkerOptions` — put these fields at the
   * top level. Still shallow-merged for compatibility. Removed in 0.3.0.
   */
  bullWorkerOptions?: Partial<WorkerOptions>
}
