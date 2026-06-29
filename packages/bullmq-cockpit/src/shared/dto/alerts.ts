/** Alert rule + notification channel contracts. */

/**
 * What a rule watches. All are derived from live queue counts (a single
 * `listQueues`) except `stuck`, which counts durable stuck instances globally.
 */
export type AlertMetric =
  | "failed" // jobs currently in the failed set
  | "backlog" // waiting + delayed + waiting-children
  | "waiting" // jobs in the waiting set
  | "active" // jobs in the active set
  | "no_workers" // pending work with zero workers attached
  | "stuck" // durable stuck instances (global, ignores queue)

export type AlertOperator = "gt" | "gte" | "lt" | "lte"

export const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  failed: "Failed jobs",
  backlog: "Backlog (waiting + delayed)",
  waiting: "Waiting jobs",
  active: "Active jobs",
  no_workers: "Pending with no workers",
  stuck: "Durable stuck instances",
}

export interface AlertRule {
  id: string
  name: string
  metric: AlertMetric
  /** Target queue, or `"*"`/undefined for "any queue". Ignored for `stuck`. */
  queue?: string
  operator: AlertOperator
  threshold: number
  enabled: boolean
  /** Channel ids notified when this rule transitions into firing. */
  channels: string[]
  createdAt: number
}

export type AlertChannelType = "webhook" | "slack"

export interface AlertChannel {
  id: string
  name: string
  type: AlertChannelType
  url: string
  createdAt: number
}

export interface AlertOffender {
  queue: string
  value: number
}

export interface AlertEvaluation {
  rule: AlertRule
  firing: boolean
  /** The value that decided it (the worst offending queue for "any queue"). */
  value: number
  /** Queues that breached the threshold (empty for `stuck` / single-queue). */
  offenders: AlertOffender[]
  /** When the rule first started firing (persisted), if currently firing. */
  since?: number
  observedAt: number
}

export interface AlertsOverview {
  evaluations: AlertEvaluation[]
  firing: number
  total: number
  channels: number
}
