/** Overview + health contracts. */

import type { DurableInstanceStatus, DurableStatusCounts, StuckKind } from "./durable"
import type { JobCounts } from "./jobs"
import type { QueueSummary } from "./queues"

export interface OverviewStats {
  queues: number
  jobs: JobCounts
  durable?: DurableStatusCounts
  /** Per-queue mini-summaries for the overview grid. */
  topQueues: QueueSummary[]
  generatedAt: number
}

export interface StuckInstance {
  kind: StuckKind
  detail: string
  instanceId?: string
  queueName: string
  jobName?: string
  status?: DurableInstanceStatus
  nextRunAt?: number
  updatedAt?: number
  /** The orphaned BullMQ job id, for `orphan_resume_job`. */
  jobId?: string
}

export interface Health {
  redis: { ok: boolean; latencyMs?: number; error?: string }
  durableEnabled: boolean
  queues: number
  generatedAt: number
}

export interface StuckReport {
  thresholdMs: number
  stuck: StuckInstance[]
  countsByKind: Record<StuckKind, number>
}
