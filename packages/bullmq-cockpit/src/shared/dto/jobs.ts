/** Plain BullMQ job contracts. */

/** BullMQ job-count buckets. */
export interface JobCounts {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
  paused: number
  prioritized: number
  "waiting-children": number
}

/** A BullMQ lifecycle state. `unknown` covers jobs we cannot classify. */
export type JobState =
  | "waiting"
  | "waiting-children"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "paused"
  | "prioritized"
  | "unknown"

/** Correlation between a BullMQ job and a durable instance, when present. */
export interface JobDurableLink {
  instanceId: string
  /** True when this job is a durable *resume* tick, not the original job. */
  isResume: boolean
  resumeSeq?: number
}

export interface JobSummary {
  id: string
  name: string
  queueName: string
  state: JobState
  attemptsMade: number
  maxAttempts?: number
  priority?: number
  delay?: number
  /** Creation time (BullMQ `timestamp`). */
  timestamp?: number
  processedOn?: number
  finishedOn?: number
  durationMs?: number
  progress?: number | object | null
  failedReason?: string
  durable?: JobDurableLink
}

export interface JobDetail extends JobSummary {
  /** Optional: a job whose data is `undefined` carries no `data` over JSON. */
  data?: unknown
  returnValue?: unknown
  stacktrace?: string[]
  opts?: Record<string, unknown>
}

export interface JobLogs {
  logs: string[]
  count: number
}

/** A node in a BullMQ flow/dependency tree. */
export interface JobDependencies {
  parent?: { queueName: string; id: string } | null
  children: Array<{ queueName: string; id: string; name: string; state: JobState }>
  unprocessedChildren: number
}
