/**
 * A Redis-free test harness for the durable runtime.
 *
 * It drives the exact same {@link DurableRuntime} the worker uses, but swaps the
 * BullMQ-backed resume scheduler for an in-memory queue that records resume
 * requests. Tests can then `drain()` those requests to simulate time passing and
 * the worker re-delivering the job — without any Redis or BullMQ.
 */

import {
  createInstanceId,
  DurableRuntime,
  type DurableProcessor,
  type DurableProcessorInput,
  type DurableProcessorHandlers,
  type InstanceState,
  MemoryStateStore,
  type ResumeScheduler,
  type RetentionOptions,
  type RunOutcome,
  type ScheduleResumeInput,
  type StateStore,
  type StepOptions,
} from "../../src/index"
import { parseDuration } from "../../src/utils/duration"

export interface TestEngineOptions {
  store?: StateStore
  queueName?: string
  defaultStepOptions?: StepOptions
  retention?: RetentionOptions
  lockTimeout?: string | number
  maxLogs?: number
}

interface TickParams {
  jobName: string
  jobData: unknown
  originalJobId: string
  instanceId: string
}

/** Build a minimal stand-in for a BullMQ job. */
function makeFakeJob(params: TickParams & { logs: string[] }) {
  return {
    id: params.originalJobId,
    name: params.jobName,
    data: params.jobData,
    durableId: params.instanceId,
    log: async (message: string) => {
      params.logs.push(message)
    },
  }
}

export class TestEngine {
  readonly store: StateStore
  readonly queueName: string
  /** Mirrored BullMQ job logs, keyed loosely for inspection. */
  readonly jobLogs: string[] = []

  private readonly pending: ScheduleResumeInput[] = []
  private readonly scheduler: ResumeScheduler = {
    scheduleResume: async (input) => {
      this.pending.push(input)
    },
  }

  constructor(
    private readonly processor: DurableProcessorInput<any>,
    private readonly options: TestEngineOptions = {},
  ) {
    this.store = options.store ?? new MemoryStateStore()
    this.queueName = options.queueName ?? "test"
  }

  /** Number of resume ticks waiting to be drained. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** Inspect (a copy of) the queued resume requests. */
  peekPending(): ScheduleResumeInput[] {
    return [...this.pending]
  }

  instanceId(jobId: string): string {
    return createInstanceId(this.queueName, jobId)
  }

  /** Run the first execution tick for a freshly added job. */
  async start(jobName: string, jobData: unknown, jobId: string): Promise<RunOutcome> {
    return this.tick({
      jobName,
      jobData,
      originalJobId: jobId,
      instanceId: this.instanceId(jobId),
    })
  }

  /** Process queued resume requests until none remain (ignores delays). */
  async drain(maxTicks = 200): Promise<{ ticks: number; last?: RunOutcome }> {
    let ticks = 0
    let last: RunOutcome | undefined
    while (this.pending.length > 0) {
      if (++ticks > maxTicks) {
        throw new Error(`drain() exceeded ${maxTicks} ticks — possible infinite resume loop`)
      }
      const next = this.pending.shift()!
      last = await this.tick({
        jobName: next.jobName,
        jobData: next.jobData,
        originalJobId: next.originalJobId,
        instanceId: next.instanceId,
      })
    }
    return { ticks, last }
  }

  /** Convenience: run the first tick, then drain to completion. */
  async run(
    jobName: string,
    jobData: unknown,
    jobId: string,
  ): Promise<{ outcome: RunOutcome; instance: InstanceState | null; ticks: number }> {
    const first = await this.start(jobName, jobData, jobId)
    const { ticks, last } = await this.drain()
    const instance = await this.store.getInstance(this.instanceId(jobId))
    return { outcome: last ?? first, instance, ticks }
  }

  /**
   * Simulate a hard crash: run a (partial) processor against a context but
   * never finalise the instance, leaving it mid-flight as a real process death
   * would. A subsequent {@link run}/{@link start} resumes and replays.
   */
  async simulateCrash(
    jobName: string,
    jobData: unknown,
    jobId: string,
    partial: DurableProcessor,
  ): Promise<void> {
    const instanceId = this.instanceId(jobId)
    await this.store.initInstance({
      instanceId,
      queueName: this.queueName,
      jobName,
      jobId,
      input: jobData,
    })
    await this.store.updateInstance(instanceId, { status: "running", runCount: 1 })

    const runtime = this.makeRuntime({ jobName, jobData, originalJobId: jobId, instanceId })
    const ctx = runtime.createContext()
    const job = makeFakeJob({
      jobName,
      jobData,
      originalJobId: jobId,
      instanceId,
      logs: this.jobLogs,
    })
    try {
      await partial(job as never, ctx)
    } catch {
      // Swallow: the process "died" before the runtime could finalise.
    }
  }

  private async tick(params: TickParams): Promise<RunOutcome> {
    const runtime = this.makeRuntime(params)
    return runtime.run(this.resolveProcessor(params.jobName))
  }

  private makeRuntime(params: TickParams): DurableRuntime {
    return new DurableRuntime({
      instanceId: params.instanceId,
      queueName: this.queueName,
      jobName: params.jobName,
      jobData: params.jobData,
      originalJobId: params.originalJobId,
      job: makeFakeJob({ ...params, logs: this.jobLogs }) as never,
      store: this.store,
      scheduler: this.scheduler,
      defaultStepOptions: this.options.defaultStepOptions,
      retention: this.options.retention,
      lockTimeoutMs: parseDuration(this.options.lockTimeout ?? "5m"),
      maxLogs: this.options.maxLogs ?? 1000,
    })
  }

  private resolveProcessor(jobName: string): DurableProcessor {
    if (typeof this.processor === "function") {
      return this.processor as DurableProcessor
    }
    const handlers = this.processor as DurableProcessorHandlers<any>
    const handler = handlers[jobName]
    if (!handler) throw new Error(`No processor for job "${jobName}"`)
    return handler as DurableProcessor
  }
}
