/** Queue summary contracts. */

import type { JobCounts } from "./jobs"

export interface QueueSummary {
  name: string
  counts: JobCounts
  isPaused: boolean
  /** Number of currently connected workers (best effort). */
  workers: number
}

export interface QueueDetail extends QueueSummary {
  /** BullMQ key prefix (the `bull` namespace). */
  prefix: string
  /** Whether any `bullmq-durable` instances were seen for this queue. */
  durable: boolean
}
