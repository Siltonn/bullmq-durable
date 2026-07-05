/** Durable-instance contracts (bullmq-durable). */

import type { Paginated, SerializedError } from "./common"

/** The raw, persisted instance status. */
export type DurableInstanceStatus =
  | "running"
  | "yielded"
  | "compensating"
  | "completed"
  | "failed"
  | "compensation_failed"
  | "cancelled"

/**
 * A friendlier status derived for the UI. The runtime collapses sleep / retry /
 * `retryLater` into a single `yielded` status; we split it back apart by
 * inspecting the in-flight step so the dashboard can show "sleeping" vs
 * "retrying" vs "waiting". `compensating` / `compensation_failed` pass through.
 */
export type DurableDerivedStatus =
  | "running"
  | "sleeping"
  | "retrying"
  | "waiting"
  | "compensating"
  | "completed"
  | "failed"
  | "compensation_failed"
  | "cancelled"

export type DurableStepType = "step" | "sleep"

export type DurableStepStatus = "running" | "completed" | "failed" | "sleeping" | "skipped"

/**
 * Lifecycle phase of a step. `main` is the forward run; `compensation` is a
 * per-step `onRollback`; `failure` is a step inside the `onFailure` handler.
 * Absent means `main` (older data).
 */
export type DurableStepPhase = "main" | "compensation" | "failure"

export interface DurableStep {
  key: string
  type: DurableStepType
  /** Lifecycle phase; absent means `main`. */
  phase?: DurableStepPhase
  status: DurableStepStatus
  attempts: number
  maxAttempts?: number
  /** Monotonic per-instance order key (stable step timeline; orders compensation). */
  seq?: number
  startedAt?: number
  completedAt?: number
  failedAt?: number
  nextRunAt?: number
  durationMs?: number
  /** Truncated preview of the checkpointed result (full value in detail only). */
  resultPreview?: unknown
  /** For `sleep` steps, the wall-clock time the sleep elapses/elapsed. */
  sleepUntil?: number
  error?: SerializedError
}

/** One compensation's outcome, surfaced in the instance detail. */
export interface DurableCompensationOutcome {
  key: string
  status: "rolled-back" | "failed" | "skipped"
  error?: SerializedError
}

/** Report of the compensation phase that ran on terminal failure. */
export interface DurableCompensationReport {
  rolledBack: string[]
  failed: DurableCompensationOutcome[]
}

/** The four classes of "stuck" durable instance the dashboard surfaces. */
export type StuckKind = "running_stale" | "resume_missed" | "orphan_resume_job" | "orphan_instance"

export interface DurableInstanceSummary {
  id: string
  /** The user-supplied original job id — the "business id" most users key on. */
  businessId: string
  queueName: string
  jobName: string
  originalJobId: string
  status: DurableInstanceStatus
  derivedStatus: DurableDerivedStatus
  currentStepKey?: string
  currentStepStatus?: DurableStepStatus
  /** Attempts on the in-flight step (for the "12/60" retry display). */
  currentAttempts?: number
  currentMaxAttempts?: number
  /** Steps discovered so far, and how many have completed. */
  stepCount: number
  completedSteps: number
  runCount: number
  resumeSeq: number
  nextRunAt?: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  failedAt?: number
  durationMs?: number
  /** Set when the health inspector flags this instance as stuck. */
  stuck?: StuckKind | null
}

export interface DurableInstanceDetail extends DurableInstanceSummary {
  input?: unknown
  output?: unknown
  error?: SerializedError
  /** The step whose failure triggered the terminal sequence, if any. */
  failedStep?: string
  /** Compensation report, present once the instance reaches a terminal failure. */
  compensation?: DurableCompensationReport
  steps: DurableStep[]
  stepCount: number
  completedSteps: number
}

/** The durable list response: a page of summaries plus a truncation flag. */
export type DurableInstanceList = Paginated<DurableInstanceSummary> & {
  /** A terminal bucket exceeded the load window, so deeper pages are capped to
   *  the most recent instances. */
  truncated?: boolean
}

export interface DurableLogEntry {
  message: string
  meta?: Record<string, unknown>
  timestamp: number
  /** `"log"` user entry / `"event"` runtime failure-path event / `"raw"` foreign job.log line. */
  kind?: "log" | "event" | "raw"
  /** Which delivery of the run emitted this (1-based). */
  runCount?: number
  /** Which BullMQ attempt cycle (real failures only). */
  jobAttempt?: number
  /** Step attribution, when emitted inside a step. */
  step?: string
  stepAttempt?: number
  /** Runtime event code (kind === "event"). */
  event?: string
  err?: { name: string; message: string }
}

/** A unified, chronological timeline entry synthesized from steps + logs. */
export interface DurableEvent {
  timestamp: number
  type: "instance" | "step" | "sleep" | "retry" | "log" | "error"
  level: "info" | "warn" | "error"
  message: string
  stepKey?: string
  meta?: Record<string, unknown>
}

/** The durable instance status histogram, shown on the overview. */
export interface DurableStatusCounts {
  running: number
  sleeping: number
  retrying: number
  waiting: number
  compensating: number
  completed: number
  failed: number
  compensation_failed: number
  cancelled: number
  stuck: number
  total: number
}
