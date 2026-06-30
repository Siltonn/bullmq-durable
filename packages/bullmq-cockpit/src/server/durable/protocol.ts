/**
 * The `bullmq-durable` Redis protocol, mirrored.
 *
 * The cockpit is decoupled from the runtime: it speaks the *documented* Redis
 * layout rather than importing `bullmq-durable`, so a plain-BullMQ user can run
 * the dashboard without the runtime installed. The shapes and key formats here
 * are a faithful copy of `bullmq-durable`'s `utils/keys.ts`, `types.ts`, and
 * `envelope.ts`. If the runtime's on-disk format ever changes, update this file
 * to match.
 *
 * Layout (per instance id `{queueName}:{jobId}`):
 *  - `{prefix}:instance:{id}`  Hash   — instance fields
 *  - `{prefix}:steps:{id}`     Hash   — stepKey -> JSON(StoredStepState)
 *  - `{prefix}:logs:{id}`      List   — bounded, chronological JSON(StoredLog)
 *  - `{prefix}:lock:{id}`      String — advisory instance lock (token)
 *
 * The runtime maintains a secondary **status index** (`idx:*`, mirrored below)
 * from the first instance, so the cockpit reads status counts + the in-flight set
 * without scanning. There is no separate "events" store — the timeline is
 * synthesized from steps + logs + lifecycle timestamps.
 */

/** The runtime's default Redis key prefix. */
export const DEFAULT_DURABLE_PREFIX = "bullmq-durable"

/** Reserved key carrying durable metadata on resume jobs. */
export const DURABLE_META_KEY = "__durable__"

// ---------------------------------------------------------------------------
// Persisted shapes (copied from bullmq-durable/src/types.ts)
// ---------------------------------------------------------------------------

export interface StoredSerializedError {
  name: string
  message: string
  stack?: string
  code?: string | number
}

export type StoredInstanceStatus =
  | "running"
  | "yielded"
  | "compensating"
  | "completed"
  | "failed"
  | "compensation_failed"
  | "cancelled"

export type StoredStepPhase = "main" | "compensation" | "failure"

export interface StoredCompensationOutcome {
  key: string
  status: "rolled-back" | "failed" | "skipped"
  error?: StoredSerializedError
}

export interface StoredCompensationReport {
  rolledBack: string[]
  failed: StoredCompensationOutcome[]
}

export interface StoredInstanceState {
  id: string
  queueName: string
  jobName: string
  originalJobId: string
  status: StoredInstanceStatus
  input?: unknown
  output?: unknown
  error?: StoredSerializedError
  /** The error that triggered the compensating phase. */
  failureError?: StoredSerializedError
  /** The step whose failure triggered the terminal sequence. */
  failedStep?: string
  /** Compensation report, present at a terminal failure. */
  compensation?: StoredCompensationReport
  runCount: number
  resumeSeq: number
  stepSeq?: number
  createdAt: number
  updatedAt: number
  completedAt?: number
  failedAt?: number
}

export type StoredStepType = "step" | "sleep"

export type StoredStepStatus = "running" | "completed" | "failed" | "sleeping" | "skipped"

export interface StoredStepState {
  key: string
  type: StoredStepType
  phase?: StoredStepPhase
  seq?: number
  status: StoredStepStatus
  result?: unknown
  error?: StoredSerializedError
  attempts: number
  startedAt?: number
  completedAt?: number
  failedAt?: number
  nextRunAt?: number
}

export interface StoredLog {
  message: string
  meta?: Record<string, unknown>
  timestamp: number
}

export interface DurableResumeMeta {
  instanceId: string
  originalJobId: string
  resumeSeq: number
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/** Stable instance id for a job: derived from the *original* job id. */
export function createInstanceId(queueName: string, jobId: string | number): string {
  return `${queueName}:${jobId}`
}

export function instanceKey(prefix: string, instanceId: string): string {
  return `${prefix}:instance:${instanceId}`
}

export function stepsKey(prefix: string, instanceId: string): string {
  return `${prefix}:steps:${instanceId}`
}

export function logsKey(prefix: string, instanceId: string): string {
  return `${prefix}:logs:${instanceId}`
}

export function lockKey(prefix: string, instanceId: string): string {
  return `${prefix}:lock:${instanceId}`
}

/** The BullMQ job id used for the resume tick at a given sequence. */
export function resumeJobId(originalJobId: string, resumeSeq: number): string {
  return `${originalJobId}:resume:${resumeSeq}`
}

// ---------------------------------------------------------------------------
// Status index (mirror of bullmq-durable's idx:* keys)
// ---------------------------------------------------------------------------
//
// The runtime maintains these from the first instance, so the cockpit can read
// counts + the in-flight set without scanning. Keep in lock-step with
// bullmq-durable/utils/keys.ts.

/** Terminal statuses that each get their own index bucket. */
export type TerminalStatus = "completed" | "failed" | "compensation_failed" | "cancelled"

/** `{prefix}:idx:active` — SET of non-terminal instance ids (bounded, in-flight). */
export function activeIndexKey(prefix: string): string {
  return `${prefix}:idx:active`
}

/** `{prefix}:idx:done:{status}` — ZSET of terminal ids scored by expiry epoch. */
export function terminalIndexKey(prefix: string, status: TerminalStatus): string {
  return `${prefix}:idx:done:${status}`
}

/**
 * Default retention TTLs (ms), mirrored from bullmq-durable's `DEFAULT_RETENTION`
 * — keep in sync. The cockpit applies these only to instances it terminates
 * itself (cancel from the dashboard), since it can't see the runtime's configured
 * retention; the normal runtime-driven path uses the runtime's own value.
 */
export const DEFAULT_RETENTION_MS: Record<TerminalStatus, number> = {
  completed: 24 * 60 * 60 * 1000,
  failed: 7 * 24 * 60 * 60 * 1000,
  compensation_failed: 30 * 24 * 60 * 60 * 1000,
  cancelled: 24 * 60 * 60 * 1000,
}

// ---------------------------------------------------------------------------
// Resume-envelope detection (copied from bullmq-durable/src/envelope.ts)
// ---------------------------------------------------------------------------

export interface ResumeEnvelope {
  [DURABLE_META_KEY]: DurableResumeMeta
  payload: unknown
}

/** Detect whether a BullMQ `job.data` is a durable resume envelope. */
export function isResumeEnvelope(data: unknown): data is ResumeEnvelope {
  if (typeof data !== "object" || data === null) return false
  if (!(DURABLE_META_KEY in data) || !("payload" in data)) return false
  const meta = (data as Record<string, unknown>)[DURABLE_META_KEY]
  return (
    typeof meta === "object" &&
    meta !== null &&
    typeof (meta as DurableResumeMeta).instanceId === "string" &&
    typeof (meta as DurableResumeMeta).originalJobId === "string" &&
    typeof (meta as DurableResumeMeta).resumeSeq === "number"
  )
}

/** Split a job's data into its durable metadata (if any) and the user payload. */
export function unwrapResumeData(data: unknown): { meta?: DurableResumeMeta; payload: unknown } {
  if (isResumeEnvelope(data)) {
    return { meta: data[DURABLE_META_KEY], payload: data.payload }
  }
  return { payload: data }
}

// ---------------------------------------------------------------------------
// Hash / JSON parsing
// ---------------------------------------------------------------------------

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isNaN(n) ? undefined : n
}

function safeJsonParse(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Reconstruct an instance from its Redis hash (the inverse of the runtime). */
export function parseInstanceHash(hash: Record<string, string>): StoredInstanceState | null {
  if (!hash || Object.keys(hash).length === 0) return null
  return {
    id: hash.id ?? "",
    queueName: hash.queueName ?? "",
    jobName: hash.jobName ?? "",
    originalJobId: hash.originalJobId ?? "",
    status: (hash.status ?? "running") as StoredInstanceStatus,
    input: safeJsonParse(hash.input),
    output: safeJsonParse(hash.output),
    error: safeJsonParse(hash.error) as StoredSerializedError | undefined,
    failureError: safeJsonParse(hash.failureError) as StoredSerializedError | undefined,
    failedStep: hash.failedStep,
    compensation: safeJsonParse(hash.compensation) as StoredCompensationReport | undefined,
    runCount: toInt(hash.runCount) ?? 0,
    resumeSeq: toInt(hash.resumeSeq) ?? 0,
    stepSeq: toInt(hash.stepSeq),
    createdAt: toInt(hash.createdAt) ?? 0,
    updatedAt: toInt(hash.updatedAt) ?? 0,
    completedAt: toInt(hash.completedAt),
    failedAt: toInt(hash.failedAt),
  }
}

/** Parse a single stored step (a JSON string in the steps hash). */
export function parseStep(raw: string): StoredStepState | null {
  try {
    return JSON.parse(raw) as StoredStepState
  } catch {
    return null
  }
}

/** Parse a single stored log line. */
export function parseLog(raw: string): StoredLog | null {
  try {
    return JSON.parse(raw) as StoredLog
  } catch {
    return null
  }
}
