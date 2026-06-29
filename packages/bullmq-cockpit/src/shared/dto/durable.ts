/** Durable-instance contracts (bullmq-durable). */

import type { Paginated, SerializedError } from "./common"

/** The raw, persisted instance status. */
export type DurableInstanceStatus = "running" | "yielded" | "completed" | "failed" | "cancelled"

/**
 * A friendlier status derived for the UI. The runtime collapses sleep / retry /
 * `retryLater` into a single `yielded` status; we split it back apart by
 * inspecting the in-flight step so the dashboard can show "sleeping" vs
 * "retrying" vs "waiting".
 */
export type DurableDerivedStatus =
  | "running"
  | "sleeping"
  | "retrying"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"

export type DurableStepType = "step" | "sleep"

export type DurableStepStatus = "running" | "completed" | "failed" | "sleeping" | "skipped"

export interface DurableStep {
  key: string
  type: DurableStepType
  status: DurableStepStatus
  attempts: number
  maxAttempts?: number
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
  completed: number
  failed: number
  cancelled: number
  stuck: number
  total: number
}
