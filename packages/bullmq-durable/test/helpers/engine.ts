/**
 * A Redis-free test harness for the durable runtime.
 *
 * It drives the exact same {@link DurableRuntime} the worker uses, but against
 * a fake BullMQ job: `moveToDelayed` parks the job in an in-memory pending
 * list, and `drain()` re-delivers the SAME job (one run = one job), simulating
 * time passing. `retriable` outcomes replay BullMQ's own attempts accounting:
 * bump `attemptsMade`, re-deliver. No Redis, no BullMQ.
 */

import {
  createInstanceId,
  DurableRuntime,
  type DurableFailureHandler,
  type DurableJobHandler,
  type DurableProcessor,
  type DurableProcessorInput,
  type DurableProcessorHandlers,
  type DurableRuntimeJob,
  type InstanceState,
  MemoryStateStore,
  type RetryOptions,
  type RunOutcome,
  type StateStore,
  type StepOptions,
} from "../../src/index"

export interface TestEngineOptions {
  store?: StateStore
  queueName?: string
  defaultStepOptions?: StepOptions
  defaultRollbackRetry?: RetryOptions
  /** A worker-level default terminal-failure handler. */
  onFailure?: DurableFailureHandler
  /** BullMQ `attempts` applied to every fake job (default 1, like BullMQ). */
  attempts?: number
}

/** A parked (delayed) fake job awaiting re-delivery. */
export interface PendingDelivery {
  jobId: string
  jobName: string
  delayMs: number
  dueAt: number
}

interface FakeJob extends DurableRuntimeJob {
  id: string
  name: string
  data: unknown
  durableId: string
  attemptsMade: number
  opts: { attempts?: number }
  discarded?: boolean
}

export class TestEngine {
  readonly store: StateStore
  readonly queueName: string
  /** BullMQ job log lines (where `ctx.log` writes). */
  readonly jobLogs: string[] = []

  private readonly jobs = new Map<string, FakeJob>()
  private readonly pending: PendingDelivery[] = []
  /**
   * Virtual clock injected into the runtime. `drain()` jumps it to each parked
   * delivery's due time, so sleeps/backoffs elapse instantly but the runtime
   * still observes correct wall-clock ordering (a re-delivered sleep really is
   * "past" its nextRunAt).
   */
  private virtualNow = Date.now()

  constructor(
    private readonly processor: DurableProcessorInput,
    private readonly options: TestEngineOptions = {},
  ) {
    this.store = options.store ?? new MemoryStateStore()
    this.queueName = options.queueName ?? "test"
  }

  /** Number of parked deliveries waiting to be drained. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** Inspect (a copy of) the parked deliveries. */
  peekPending(): PendingDelivery[] {
    return [...this.pending]
  }

  instanceId(jobId: string): string {
    return createInstanceId(this.queueName, jobId)
  }

  /** The fake job backing a run (attemptsMade, logs, …), if it exists. */
  job(jobId: string): FakeJob | undefined {
    return this.jobs.get(jobId)
  }

  /** Run the first execution tick for a freshly added job. */
  async start(jobName: string, jobData: unknown, jobId: string): Promise<RunOutcome> {
    return this.tick(this.ensureJob(jobName, jobData, jobId))
  }

  /** Re-deliver parked jobs until none remain (ignores delays). */
  async drain(maxTicks = 200): Promise<{ ticks: number; last?: RunOutcome }> {
    let ticks = 0
    let last: RunOutcome | undefined
    while (this.pending.length > 0) {
      if (++ticks > maxTicks) {
        throw new Error(`drain() exceeded ${maxTicks} ticks — possible infinite resume loop`)
      }
      const next = this.pending.shift()!
      // Time travel: the delayed job is only ever delivered AT its due time.
      this.virtualNow = Math.max(this.virtualNow, next.dueAt)
      const job = this.jobs.get(next.jobId)
      if (!job) continue
      last = await this.tick(job)
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
   * Deliver a job's tick RIGHT NOW without advancing the virtual clock — an
   * early re-delivery (stall takeover, manual promote). Drops any parked entry
   * for the job first, since the real delayed entry would be consumed too.
   */
  async deliverNow(jobId: string): Promise<RunOutcome> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`deliverNow(): no fake job "${jobId}" — start() it first`)
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.jobId === jobId) this.pending.splice(i, 1)
    }
    return this.tick(job)
  }

  /**
   * Run a post-mortem settlement tick (what the worker's `failed` listener does
   * for stall-death / mid-settlement crashes).
   */
  async settle(jobId: string, error: unknown): Promise<RunOutcome> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`settle(): no fake job "${jobId}" — start() it first`)
    const runtime = this.makeRuntime(job, { mode: "settle", settleError: error })
    return runtime.run(this.resolveProcessor(job.name))
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

    const job = this.ensureJob(jobName, jobData, jobId)
    const runtime = this.makeRuntime(job)
    const ctx = runtime.createContext()
    try {
      await partial(job as never, ctx)
    } catch {
      // Swallow: the process "died" before the runtime could finalise.
    }
  }

  // -- Internals -----------------------------------------------------------

  private ensureJob(jobName: string, jobData: unknown, jobId: string): FakeJob {
    const existing = this.jobs.get(jobId)
    if (existing) return existing

    const engine = this
    const job: FakeJob = {
      id: jobId,
      name: jobName,
      data: jobData,
      durableId: this.instanceId(jobId),
      attemptsMade: 0,
      opts: { attempts: this.options.attempts ?? 1 },
      log: async (message: string) => {
        engine.jobLogs.push(message)
      },
      moveToDelayed: async (timestamp: number, token?: string) => {
        if (token !== "test-token") {
          throw new Error(`moveToDelayed called with wrong token: ${String(token)}`)
        }
        engine.pending.push({
          jobId,
          jobName,
          delayMs: Math.max(0, timestamp - engine.virtualNow),
          dueAt: timestamp,
        })
      },
    }
    this.jobs.set(jobId, job)
    return job
  }

  private async tick(job: FakeJob): Promise<RunOutcome> {
    const runtime = this.makeRuntime(job)
    const outcome = await runtime.run(this.resolveProcessor(job.name))

    // Mirror BullMQ's retry accounting: a retriable throw increments
    // attemptsMade and re-delivers while attempts remain.
    if (outcome.type === "retriable") {
      job.attemptsMade += 1
      if (job.attemptsMade < (job.opts.attempts ?? 1)) {
        this.pending.push({ jobId: job.id, jobName: job.name, delayMs: 0, dueAt: this.virtualNow })
      }
    }
    return outcome
  }

  private makeRuntime(
    job: FakeJob,
    extra?: { mode?: "settle"; settleError?: unknown },
  ): DurableRuntime {
    return new DurableRuntime({
      instanceId: job.durableId,
      queueName: this.queueName,
      jobName: job.name,
      jobData: job.data,
      originalJobId: job.id,
      job,
      token: "test-token",
      store: this.store,
      defaultStepOptions: this.options.defaultStepOptions,
      defaultRollbackRetry: this.options.defaultRollbackRetry,
      onFailure: this.resolveOnFailure(job.name) ?? this.options.onFailure,
      clock: () => this.virtualNow,
      ...extra,
    })
  }

  private resolveProcessor(jobName: string): DurableProcessor {
    if (typeof this.processor === "function") {
      return this.processor as DurableProcessor
    }
    const handlers = this.processor as DurableProcessorHandlers
    const handler = handlers[jobName]
    if (!handler) throw new Error(`No processor for job "${jobName}"`)
    if (typeof handler === "function") return handler as DurableProcessor
    return (handler as DurableJobHandler).run as DurableProcessor
  }

  /** Per-job `onFailure` from a `{ run, onFailure }` handler entry, if present. */
  private resolveOnFailure(jobName: string): DurableFailureHandler | undefined {
    if (typeof this.processor === "function") return undefined
    const handler = (this.processor as DurableProcessorHandlers)[jobName]
    if (!handler || typeof handler === "function") return undefined
    return (handler as DurableJobHandler).onFailure
  }
}
