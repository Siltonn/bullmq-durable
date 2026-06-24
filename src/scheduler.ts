/**
 * The resume-scheduling seam.
 *
 * When an instance yields (after `ctx.sleep`, a scheduled retry, or
 * `ctx.retryLater`), the runtime asks a {@link ResumeScheduler} to enqueue a
 * delayed "resume tick". In production this is backed by a BullMQ queue
 * (`BullResumeScheduler`); tests provide an in-memory scheduler so the runtime
 * can be driven without Redis.
 */

/** Everything needed to re-deliver an instance for another execution tick. */
export interface ScheduleResumeInput {
  instanceId: string
  queueName: string
  jobName: string
  /** The original user payload; re-added verbatim on the resume job. */
  jobData: unknown
  /** Stable BullMQ job id of the first tick. */
  originalJobId: string
  /** Monotonic resume counter, used to build a unique resume job id. */
  resumeSeq: number
  /** Delay before the resume should fire. */
  delayMs: number
  /** Human-readable reason (sleep / retry / retryLater), for observability. */
  reason: string
}

export interface ResumeScheduler {
  scheduleResume(input: ScheduleResumeInput): Promise<void>
}
