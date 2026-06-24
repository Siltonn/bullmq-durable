/**
 * Public type definitions for bullmq-durable.
 *
 * This module is intentionally free of runtime code so it can be imported from
 * anywhere without side effects.
 */

import type { ConnectionOptions, Job, JobsOptions, WorkerOptions } from "bullmq"
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

/** Backoff strategy applied between step retries. */
export type BackoffType = "fixed" | "exponential"

/** Retry policy for a single step. */
export interface RetryOptions {
  /** Maximum number of attempts (including the first). Defaults to `1`. */
  attempts?: number
  /** Backoff strategy. Defaults to `"fixed"`. */
  backoff?: BackoffType
  /** Base delay between attempts. Defaults to `0`. */
  delay?: DurationInput
  /** Optional cap on the computed delay (useful with exponential backoff). */
  maxDelay?: DurationInput
}

/** Options accepted by `ctx.step(key, options, fn)`. */
export interface StepOptions {
  /** Retry policy for this step. */
  retry?: RetryOptions
}

// ---------------------------------------------------------------------------
// Step state machine
// ---------------------------------------------------------------------------

export type StepStatus = "running" | "completed" | "failed" | "sleeping" | "skipped"

export type StepType = "step" | "sleep"

/** Persisted state for a single step within an instance. */
export interface StepState {
  key: string
  type: StepType
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

export type InstanceStatus = "running" | "yielded" | "completed" | "failed" | "cancelled"

/** Persisted state for a durable instance — the real unit of execution. */
export interface InstanceState {
  id: string
  queueName: string
  jobName: string
  /** The BullMQ job id of the very first tick; stays stable across resumes. */
  originalJobId: string
  status: InstanceStatus
  input: unknown
  output?: unknown
  error?: SerializedError
  /** How many times the processor has been (re)entered for this instance. */
  runCount: number
  /** Monotonic counter used to give each resume job a unique id. */
  resumeSeq: number
  createdAt: number
  updatedAt: number
  completedAt?: number
  failedAt?: number
}

/** A single structured log line attached to an instance. */
export interface DurableLog {
  message: string
  meta?: Record<string, unknown>
  timestamp: number
}

// ---------------------------------------------------------------------------
// Job map typing
// ---------------------------------------------------------------------------

/** Describes the input/output shape of one named job. */
export interface DurableJobSpec {
  data: unknown
  result: unknown
}

/** A map of job name -> {@link DurableJobSpec}, used for end-to-end typing. */
export type DurableJobMap = Record<string, DurableJobSpec>

/** Extract the `data` type for job `TName` from a job map. */
export type JobData<TJobs extends DurableJobMap, TName extends keyof TJobs> = TJobs[TName]["data"]

/** Extract the `result` type for job `TName` from a job map. */
export type JobResult<
  TJobs extends DurableJobMap,
  TName extends keyof TJobs,
> = TJobs[TName]["result"]

/**
 * A BullMQ {@link Job} augmented with its durable instance id. The `data`
 * exposed here is always the original user payload — durable metadata is
 * stripped before the processor runs.
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
  step<T>(key: string, options: StepOptions, fn: StepFn<T>): Promise<T>

  /** Pause the instance for `duration` without occupying a worker. */
  sleep(key: string, duration: DurationInput): Promise<void>

  /** Pause the instance until a specific wall-clock time. */
  sleepUntil(key: string, date: Date | number): Promise<void>

  /** Build a `RetryLaterError` to throw from within a step. */
  retryLater(reason?: string): RetryLaterError
  retryLater(delay: DurationInput, reason?: string): RetryLaterError

  /** Build a `DurableNonRetryableError` that fails the instance immediately. */
  nonRetryable(reason: string): DurableNonRetryableError

  /** Append a structured log line to the instance (also mirrored to job logs). */
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

/** A map of job name -> processor, for multi-job workers. */
export type DurableProcessorHandlers<TJobs extends DurableJobMap> = {
  [K in keyof TJobs & string]: DurableProcessor<JobData<TJobs, K>, JobResult<TJobs, K>, K>
}

/**
 * The processor argument accepted by `DurableWorker`: either a single function
 * that handles every job name, or a per-name handler map.
 */
export type DurableProcessorInput<TJobs extends DurableJobMap> =
  | DurableProcessor<any, any, string>
  | DurableProcessorHandlers<TJobs>

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** How long to retain finished instances before they expire from the store. */
export interface RetentionOptions {
  /** TTL applied once an instance completes. */
  completed?: DurationInput
  /** TTL applied once an instance fails. */
  failed?: DurationInput
}

/** Options for {@link DurableQueue}. */
export interface DurableQueueOptions {
  connection: ConnectionOptions
  /** Custom state store. Defaults to a `RedisStateStore` built from `connection`. */
  stateStore?: StateStore
  /** Redis key prefix for durable state. Defaults to `"bullmq-durable"`. */
  durablePrefix?: string
  /** BullMQ's own key prefix (the `bull` namespace). */
  bullPrefix?: string
  /** Default BullMQ job options applied to every `add`. */
  defaultJobOptions?: JobsOptions
  /**
   * BullMQ `attempts` for the internally-scheduled resume jobs (sleep / retry /
   * `retryLater` ticks). A value `> 1` lets BullMQ retry a resume tick whose
   * *next* resume failed to enqueue, instead of stranding the instance in
   * `yielded`. Replays are idempotent, so this is always safe. Defaults to `3`.
   */
  resumeAttempts?: number
}

/** Options for {@link DurableWorker}. */
export interface DurableWorkerOptions {
  connection: ConnectionOptions
  /** Custom state store. Defaults to a `RedisStateStore` built from `connection`. */
  stateStore?: StateStore
  /** Redis key prefix for durable state. Defaults to `"bullmq-durable"`. */
  durablePrefix?: string
  /** BullMQ's own key prefix (the `bull` namespace). */
  bullPrefix?: string
  /** Number of jobs processed concurrently. Forwarded to BullMQ. */
  concurrency?: number
  /** Instance lock TTL. Defaults to `"5m"`. */
  lockTimeout?: DurationInput
  /** Retention policy for finished instances. */
  retention?: RetentionOptions
  /** Default step options merged into every `ctx.step` call. */
  defaultStepOptions?: StepOptions
  /** Maximum number of log entries kept per instance. Defaults to `1000`. */
  maxLogs?: number
  /**
   * BullMQ `attempts` for internally-scheduled resume jobs. See
   * {@link DurableQueueOptions.resumeAttempts}. Defaults to `3`.
   */
  resumeAttempts?: number
  /** Escape hatch: extra BullMQ worker options merged verbatim. */
  bullWorkerOptions?: Partial<WorkerOptions>
}
