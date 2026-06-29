/** Scheduler (repeatable / cron job) contracts. */

export interface SchedulerSummary {
  /** The internal scheduler key. */
  key: string
  /** The scheduler id (stable, user-chosen). */
  id: string
  /** The job name produced by the scheduler. */
  name: string
  queueName: string
  /** A cron expression, when the scheduler is cron-based. */
  pattern?: string
  /** A fixed interval in ms, when the scheduler is interval-based. */
  every?: number
  tz?: string
  /** Next fire time (epoch ms). */
  next?: number
  endDate?: number
  limit?: number
  /** The job template (data/opts) the scheduler stamps onto each run. */
  template?: { data?: unknown; opts?: Record<string, unknown> }
}
