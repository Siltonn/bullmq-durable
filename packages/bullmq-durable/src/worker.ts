/**
 * {@link DurableWorker} — wraps a BullMQ `Worker` and runs each job through the
 * durable runtime.
 *
 * Differences from a plain BullMQ worker:
 *  - the processor receives a second `ctx` argument (the durable context);
 *  - resume ticks are unwrapped so the processor only sees its own payload;
 *  - completion / yield / failure are translated to BullMQ return semantics.
 */

import { Worker } from "bullmq"
import type { Job, WorkerOptions } from "bullmq"
import { DurableQueue } from "./queue"
import { DurableRuntime, type RunOutcome } from "./runtime"
import { RedisStateStore } from "./store/redis-store"
import type { StateStore } from "./store/state-store"
import type {
  DurableJob,
  DurableJobMap,
  DurableProcessor,
  DurableProcessorHandlers,
  DurableProcessorInput,
  DurableWorkerOptions,
} from "./types"
import { unwrapResumeData } from "./envelope"
import { parseDuration } from "./utils/duration"
import { createInstanceId, DEFAULT_DURABLE_PREFIX } from "./utils/keys"

const DEFAULT_LOCK_TIMEOUT = "5m"
const DEFAULT_MAX_LOGS = 1000

export class DurableWorker<TJobs extends DurableJobMap = DurableJobMap> {
  private readonly bullWorker: Worker
  private readonly store: StateStore
  private readonly ownsStore: boolean
  /** Internal queue used purely to schedule resume ticks. */
  private readonly resumeQueue: DurableQueue<TJobs>
  private readonly lockTimeoutMs: number
  private readonly maxLogs: number

  constructor(
    readonly queueName: string,
    private readonly processorInput: DurableProcessorInput<TJobs>,
    private readonly options: DurableWorkerOptions,
  ) {
    this.ownsStore = !options.stateStore
    this.store =
      options.stateStore ??
      new RedisStateStore({
        connection: options.connection,
        prefix: options.durablePrefix ?? DEFAULT_DURABLE_PREFIX,
      })

    this.resumeQueue = new DurableQueue<TJobs>(queueName, {
      connection: options.connection,
      bullPrefix: options.bullPrefix,
      durablePrefix: options.durablePrefix,
      stateStore: this.store,
      resumeAttempts: options.resumeAttempts,
    })

    this.lockTimeoutMs = parseDuration(options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT)
    this.maxLogs = options.maxLogs ?? DEFAULT_MAX_LOGS

    this.bullWorker = new Worker(queueName, (job) => this.handleJob(job), this.buildWorkerOptions())
  }

  /** Run a single BullMQ job through the durable runtime. */
  private async handleJob(job: Job): Promise<unknown> {
    const { meta, payload } = unwrapResumeData(job.data)
    const originalJobId = meta?.originalJobId ?? String(job.id)
    const instanceId = meta?.instanceId ?? createInstanceId(this.queueName, String(job.id))

    // Present the job to user code with its own payload and instance id.
    ;(job as { data: unknown }).data = payload
    Object.defineProperty(job, "durableId", {
      value: instanceId,
      enumerable: false,
      configurable: true,
    })

    const runtime = new DurableRuntime({
      instanceId,
      queueName: this.queueName,
      jobName: job.name,
      jobData: payload,
      originalJobId,
      job: job as DurableJob & { log(message: string): Promise<unknown> },
      store: this.store,
      scheduler: this.resumeQueue,
      defaultStepOptions: this.options.defaultStepOptions,
      retention: this.options.retention,
      lockTimeoutMs: this.lockTimeoutMs,
      maxLogs: this.maxLogs,
    })

    const processor = resolveDurableProcessor(
      this.processorInput as DurableProcessorInput<DurableJobMap>,
      job.name,
      this.queueName,
    )
    return runOutcomeToReturn(await runtime.run(processor))
  }

  private buildWorkerOptions(): WorkerOptions {
    return {
      ...this.options.bullWorkerOptions,
      connection: this.options.connection,
      prefix: this.options.bullPrefix,
      concurrency: this.options.concurrency ?? this.options.bullWorkerOptions?.concurrency,
    }
  }

  // -- Pass-through surface ------------------------------------------------

  /** The underlying BullMQ worker (for event listeners, metrics, etc.). */
  get worker(): Worker {
    return this.bullWorker
  }

  /** The state store backing this worker. */
  get stateStore(): StateStore {
    return this.store
  }

  /** Subscribe to BullMQ worker events. */
  on(event: string, listener: (...args: any[]) => void): this {
    this.bullWorker.on(event as never, listener as never)
    return this
  }

  /** Resolve once the worker is connected and ready. */
  async waitUntilReady(): Promise<void> {
    await this.bullWorker.waitUntilReady()
  }

  /** Close the worker, the internal resume queue, and any store we created. */
  async close(): Promise<void> {
    await this.bullWorker.close()
    await this.resumeQueue.close()
    if (this.ownsStore) await this.store.close()
  }
}

/**
 * Translate a {@link RunOutcome} into a value to return (or an error to throw)
 * from the BullMQ processor. Exported for unit testing.
 */
export function runOutcomeToReturn(outcome: RunOutcome): unknown {
  switch (outcome.type) {
    case "completed":
      return outcome.output
    case "failed":
      // Only a fresh failure should mark the BullMQ job as failed; a stray
      // resume of an already-failed instance is a harmless no-op.
      if (outcome.fresh) throw outcome.error
      return undefined
    case "yielded":
    case "cancelled":
    case "skipped":
      return undefined
  }
}

/**
 * Pick the processor for a job name — either a single function (handles every
 * job) or a per-name handler map. Exported for unit testing.
 */
export function resolveDurableProcessor(
  input: DurableProcessorInput<DurableJobMap>,
  jobName: string,
  queueName: string,
): DurableProcessor {
  if (typeof input === "function") {
    return input as DurableProcessor
  }
  const handlers = input as DurableProcessorHandlers<DurableJobMap>
  const handler = handlers[jobName]
  if (!handler) {
    throw new Error(
      `DurableWorker: no processor registered for job "${jobName}" on queue "${queueName}"`,
    )
  }
  return handler as DurableProcessor
}
