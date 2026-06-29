/**
 * Activity & signals — the "four golden signals" (traffic / latency / errors /
 * saturation), derived from recent jobs so they work without the BullMQ metrics
 * opt-in. Plus the Redis server snapshot.
 */

/** Latency distribution over a sampled set of jobs (all values in ms). */
export interface LatencyStats {
  avg: number
  p50: number
  p95: number
  max: number
  /** How many jobs the stats were computed from (0 ⇒ no data). */
  sampled: number
}

/** A per-minute throughput bucket carrying both outcomes. */
export interface ActivityPoint {
  t: number
  completed: number
  failed: number
}

export interface JobNameStat {
  name: string
  completed: number
  failed: number
}

/**
 * Rich, derived activity for one queue over a trailing window — throughput,
 * latency (queue wait + processing), and a per-job-name breakdown.
 */
export interface QueueActivity {
  queueName: string
  windowMinutes: number
  completed: number
  failed: number
  /** failed / (completed + failed) over the window, 0..1. */
  failureRate: number
  /** Completed per minute over the window. */
  throughputPerMin: number
  perMinute: ActivityPoint[]
  /** Job processing time (finishedOn − processedOn). */
  processing: LatencyStats
  /** Queue wait time (processedOn − enqueuedAt) — how long jobs sat. */
  wait: LatencyStats
  jobNames: JobNameStat[]
  sampled: number
}

/** One queue's health row for the overview's at-a-glance table. */
export interface QueueSignal {
  name: string
  backlog: number
  active: number
  failed: number
  workers: number
  /** Age of the oldest waiting job (queue latency) in ms. */
  oldestWaitMs: number
  failureRate: number
  isPaused: boolean
}

/** System-wide golden signals for the overview header. */
export interface SystemSignals {
  windowMinutes: number
  throughputPerMin: number
  completed: number
  failed: number
  errorRate: number
  /** Total pending across queues (waiting + delayed + waiting-children). */
  backlog: number
  /** Worst queue latency across queues, in ms. */
  maxWaitMs: number
  queuesWithoutWorkers: number
  sparkline: ActivityPoint[]
  /** Per-queue rows, worst-first, for the health table. */
  queues: QueueSignal[]
  generatedAt: number
}

export interface RedisInfo {
  version?: string
  mode?: string
  uptimeSeconds?: number
  connectedClients?: number
  usedMemory?: number
  usedMemoryHuman?: string
  maxMemory?: number
  maxMemoryPolicy?: string
  opsPerSec?: number
  keyspaceHits?: number
  keyspaceMisses?: number
  evictedKeys?: number
  dbKeys?: number
}
