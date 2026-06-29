/** Time-series throughput metric contracts. */

export interface MetricPoint {
  /** Epoch ms for the start of the sample bucket. */
  t: number
  value: number
}

export interface MetricSeries {
  name: "completed" | "failed"
  count: number
  points: MetricPoint[]
}

export interface QueueMetrics {
  queueName: string
  completed: MetricSeries
  failed: MetricSeries
  /** Width of each sample bucket in ms (BullMQ samples per minute). */
  sampleMs: number
  /** Whether BullMQ metrics collection appears to be enabled for this queue. */
  enabled: boolean
  generatedAt: number
}
