/**
 * {@link DurableQueue} — a thin, type-safe wrapper around a BullMQ `Queue`.
 *
 * Adding a job is intentionally identical to BullMQ: the durable instance is
 * created lazily on the worker's first tick, not at enqueue time. This keeps
 * `add` cheap and avoids a double-write where the job is enqueued but state
 * initialisation fails.
 *
 * The underlying BullMQ queue and state store are created lazily so that simply
 * constructing a `DurableQueue` (e.g. in a DI container) does not open a Redis
 * connection until it is actually used.
 */

import { type JobsOptions, Queue } from "bullmq"
import type { ResumeScheduler, ScheduleResumeInput } from "./scheduler"
import { RedisStateStore } from "./store/redis-store"
import type { StateStore } from "./store/state-store"
import type {
  DurableJob,
  DurableJobMap,
  DurableLog,
  DurableQueueOptions,
  InstanceState,
  JobData,
  JobResult,
  StepState,
} from "./types"
import { createInstanceId, DEFAULT_DURABLE_PREFIX, resumeJobId } from "./utils/keys"
import { wrapResumeData } from "./envelope"
import { DEFAULT_RETENTION } from "./types"
import { parseDuration } from "./utils/duration"

/** BullMQ attempts for resume ticks when the caller does not override it. */
const DEFAULT_RESUME_ATTEMPTS = 3

export class DurableQueue<TJobs extends DurableJobMap = DurableJobMap> implements ResumeScheduler {
  private queue?: Queue
  private store?: StateStore
  private ownsStore = false

  constructor(
    readonly name: string,
    private readonly options: DurableQueueOptions,
  ) {}

  /** The BullMQ key prefix for durable state. */
  private get durablePrefix(): string {
    return this.options.durablePrefix ?? DEFAULT_DURABLE_PREFIX
  }

  /** Lazily construct the underlying BullMQ queue. */
  get bull(): Queue {
    if (!this.queue) {
      this.queue = new Queue(this.name, {
        connection: this.options.connection,
        prefix: this.options.bullPrefix,
        defaultJobOptions: this.options.defaultJobOptions,
      })
    }
    return this.queue
  }

  /** Lazily resolve the state store (custom one if provided, else Redis). */
  get stateStore(): StateStore {
    if (!this.store) {
      if (this.options.stateStore) {
        this.store = this.options.stateStore
      } else {
        this.store = new RedisStateStore({
          connection: this.options.connection,
          prefix: this.durablePrefix,
        })
        this.ownsStore = true
      }
    }
    return this.store
  }

  /**
   * Enqueue a durable job. Mirrors `Queue.add`, but the returned job is typed
   * as a {@link DurableJob} and annotated with its (eventual) instance id.
   */
  async add<TName extends keyof TJobs & string>(
    name: TName,
    data: JobData<TJobs, TName>,
    opts?: JobsOptions,
  ): Promise<DurableJob<JobData<TJobs, TName>, JobResult<TJobs, TName>, TName>> {
    const job = await this.bull.add(name, data as JobData<TJobs, TName>, opts)
    return annotateDurable(job, createInstanceId(this.name, job.id ?? "")) as DurableJob<
      JobData<TJobs, TName>,
      JobResult<TJobs, TName>,
      TName
    >
  }

  /**
   * Implements {@link ResumeScheduler} so a queue can schedule resume ticks
   * (used by workers that share this queue instance).
   */
  async scheduleResume(input: ScheduleResumeInput): Promise<void> {
    await this.bull.add(
      input.jobName,
      wrapResumeData(input.jobData, input.instanceId, input.originalJobId, input.resumeSeq),
      {
        delay: input.delayMs,
        jobId: resumeJobId(input.originalJobId, input.resumeSeq),
        attempts: this.options.resumeAttempts ?? DEFAULT_RESUME_ATTEMPTS,
        removeOnComplete: true,
      },
    )
  }

  // -- State queries -------------------------------------------------------

  /** The durable instance id for a given (original) job id. */
  instanceIdFor(jobId: string | number): string {
    return createInstanceId(this.name, jobId)
  }

  /** Read the durable instance state for a job. */
  async getDurableState(jobId: string | number): Promise<InstanceState | null> {
    return this.stateStore.getInstance(this.instanceIdFor(jobId))
  }

  /** Read all recorded steps for a job. */
  async getDurableSteps(jobId: string | number): Promise<StepState[]> {
    return this.stateStore.getSteps(this.instanceIdFor(jobId))
  }

  /** Read the durable logs for a job. */
  async getDurableLogs(jobId: string | number): Promise<DurableLog[]> {
    return this.stateStore.getLogs(this.instanceIdFor(jobId))
  }

  /**
   * Cancel a durable instance. Marks it cancelled (so any future tick stops at
   * the next step) and best-effort removes the pending original/resume jobs.
   *
   * Removal is by exact job id, never a scan of the delayed set: that set can
   * hold tens of thousands of jobs in a sleep/poll-heavy system, and only the
   * latest resume tick (id derived from `instance.resumeSeq`) can ever be
   * pending. Correctness does not rely on the removal — any resume that still
   * fires observes the cancelled status and stops at its next step.
   */
  async cancel(jobId: string | number): Promise<void> {
    const instanceId = this.instanceIdFor(jobId)
    // Read the instance first (for its resumeSeq), then cancel WITH the default
    // cancelled-retention TTL so an externally-cancelled instance is bounded just
    // like an in-workflow cancel. The queue can't see the worker's configured
    // `retention`, so it uses the safe default (matching the dashboard); without
    // it the cancelled state and its index entry would never expire.
    const instance = await this.stateStore.getInstance(instanceId)
    await this.stateStore.cancelInstance(instanceId, parseDuration(DEFAULT_RETENTION.cancelled))

    try {
      await this.removeJob(String(jobId))

      const resumeSeq = instance?.resumeSeq ?? 0
      if (resumeSeq > 0) {
        await this.removeJob(resumeJobId(instance?.originalJobId || String(jobId), resumeSeq))
      }
    } catch {
      // Best effort: the instance is already marked cancelled either way.
    }
  }

  /** Remove a BullMQ job by id if it exists, swallowing lock/availability errors. */
  private async removeJob(id: string): Promise<void> {
    const job = await this.bull.getJob(id)
    if (job) await job.remove().catch(() => undefined)
  }

  /** Close the underlying queue and any store we created. */
  async close(): Promise<void> {
    if (this.queue) await this.queue.close()
    if (this.store && this.ownsStore) await this.store.close()
  }
}

/** Tag a BullMQ job with its durable instance id. */
function annotateDurable<D, R, N extends string>(
  job: { id?: string },
  durableId: string,
): DurableJob<D, R, N> {
  Object.defineProperty(job, "durableId", {
    value: durableId,
    enumerable: false,
    configurable: true,
  })
  return job as unknown as DurableJob<D, R, N>
}
