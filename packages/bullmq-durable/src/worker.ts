/**
 * {@link DurableWorker} — wraps a BullMQ `Worker` and runs each job through the
 * durable runtime.
 *
 * Differences from a plain BullMQ worker:
 *  - the processor receives a second `ctx` argument (the durable context);
 *  - a run rides ONE job for its whole life: suspensions are `moveToDelayed`
 *    on that job (the worker throws `DelayedError` to park it);
 *  - a `failed` listener settles runs whose processor never got to run
 *    (stall-death) or died mid-settlement — compensation still happens;
 *  - a reaper deletes durable state once its job is gone (state follows job).
 */

import { DelayedError, type Job, Worker, type WorkerOptions } from "bullmq"
import { unwrapResumeData } from "./legacy/envelope"
import {
  DurableCancelledJobError,
  DurableTerminalJobError,
  isDurableBoundaryError,
} from "./errors"
import { bullJobKeysExist, DurableReaper } from "./reaper"
import { DurableRuntime, type DurableRuntimeJob, type RunOutcome } from "./execution/runtime"
import { RedisStateStore } from "./store/redis-store"
import type { StateStore } from "./store/state-store"
import type {
  DurableFailureHandler,
  DurableJobHandler,
  DurableProcessor,
  DurableProcessorHandlers,
  DurableProcessorInput,
  DurableWorkerOptions,
} from "./types"
import { warnOnce } from "./utils/deprecations"
import { createInstanceId, DEFAULT_DURABLE_PREFIX, isTerminalStatus } from "./utils/keys"

const TERMINAL_OUTCOMES: ReadonlySet<RunOutcome["type"]> = new Set([
  "completed",
  "failed",
  "cancelled",
])

export class DurableWorker {
  private readonly bullWorker: Worker
  private readonly store: StateStore
  private readonly ownsStore: boolean
  private readonly reaper: DurableReaper

  constructor(
    readonly queueName: string,
    private readonly processorInput: DurableProcessorInput,
    private readonly options: DurableWorkerOptions,
  ) {
    this.ownsStore = !options.stateStore
    this.store =
      options.stateStore ??
      new RedisStateStore({
        connection: options.connection,
        prefix: options.durablePrefix ?? DEFAULT_DURABLE_PREFIX,
      })

    this.bullWorker = new Worker(
      queueName,
      (job, token) => this.handleJob(job, token),
      buildWorkerOptions(options),
    )

    this.reaper = new DurableReaper({
      store: this.store,
      queueName,
      jobsExist: bullJobKeysExist(this.bullWorker),
      batch: options.reaper?.terminalBatchSize,
      throttleMs: options.reaper?.throttleMs,
      graceMs: options.reaper?.orphanGraceMs,
    })

    // Settle runs whose in-processor path never finished: stall-death (the
    // processor is never called for a stall-exceeded job) and last-attempt
    // crashes mid-settlement.
    this.bullWorker.on("failed", (job, error) => {
      void this.settleOrphanedFailure(job, error)
    })

    // Start-of-life: announce this durable queue (so dashboards detect the
    // deployment before the first run ever ticks), reconcile orphans left
    // while no worker was running, then reap state whose jobs were cleaned.
    void this.bullWorker
      .waitUntilReady()
      .then(() => this.store.registerQueue(queueName))
      .then(() => this.reaper.pass(true))
      .catch(() => undefined)
  }

  /** Run a single BullMQ job through the durable runtime. */
  private async handleJob(job: Job, token?: string): Promise<unknown> {
    // Legacy shim (0.1.x rolling upgrade): an in-flight resume job carries an
    // envelope; unwrap it and keep advancing the ORIGINAL instance. The job
    // then becomes the run's carrier under the new mechanics. Removed in 0.3.0.
    const { meta, payload } = unwrapResumeData(job.data)
    if (meta) {
      ;(job as { data: unknown }).data = payload
    }
    const instanceId = meta?.instanceId ?? createInstanceId(this.queueName, String(job.id))
    const originalJobId = meta?.originalJobId ?? String(job.id)

    annotateDurableId(job, instanceId)
    const handler = resolveDurableHandler(this.processorInput, job.name, this.queueName)

    const runtime = new DurableRuntime({
      instanceId,
      queueName: this.queueName,
      jobName: job.name,
      jobData: payload,
      originalJobId,
      job: job as unknown as DurableRuntimeJob,
      token,
      store: this.store,
      defaultStepOptions: this.options.defaultStepOptions,
      defaultRollbackRetry: this.options.defaultRollbackRetry,
      // A per-job onFailure wins over the worker-level default.
      onFailure: handler.onFailure ?? this.options.onFailure,
    })

    const outcome = await runtime.run(handler.run)
    if (TERMINAL_OUTCOMES.has(outcome.type)) {
      // State-follows-job: every finished run amortises a little reaping.
      this.reaper.kick()
    }
    return runOutcomeToReturn(outcome, instanceId)
  }

  /**
   * `failed`-event settlement: when a job dies without its in-processor
   * settlement (stall-exceeded jobs never reach the processor; a last-attempt
   * crash can die mid-compensation), run a post-mortem "settle" tick so
   * compensation and `onFailure` still execute. Replay-only on the forward
   * phase — a half-dead run must not fire new side effects.
   */
  private async settleOrphanedFailure(job: Job | undefined, error: Error): Promise<void> {
    try {
      if (!job) return

      // Our own boundary errors are the COMMON failed-event cause and always
      // follow an in-processor settlement — skip the Redis read entirely.
      // (Marker/name-robust check: a duplicated bullmq-durable copy must not
      // downgrade this into a spurious settle tick.)
      if (isDurableBoundaryError(error)) {
        this.reaper.kick()
        return
      }

      const { meta, payload } = unwrapResumeData(job.data)
      const instanceId = meta?.instanceId ?? createInstanceId(this.queueName, String(job.id))
      const instance = await this.store.getInstance(instanceId)
      if (!instance) return
      if (isTerminalStatus(instance.status)) {
        // In-processor settlement already ran (it always precedes the throw).
        this.reaper.kick()
        return
      }

      // In the `failed` event attemptsMade has already been incremented.
      const attemptsTotal = job.opts?.attempts ?? 1
      const unrecoverable =
        error instanceof Error &&
        (error.name === "UnrecoverableError" || isDurableBoundaryError(error))
      if (!unrecoverable && (job.attemptsMade ?? 0) < attemptsTotal) {
        return // BullMQ re-delivers; the live path will handle it.
      }

      const handler = resolveDurableHandler(this.processorInput, job.name, this.queueName)
      const runtime = new DurableRuntime({
        instanceId,
        queueName: this.queueName,
        jobName: job.name,
        jobData: payload,
        originalJobId: meta?.originalJobId ?? String(job.id),
        job: job as unknown as DurableRuntimeJob,
        store: this.store,
        defaultStepOptions: this.options.defaultStepOptions,
        defaultRollbackRetry: this.options.defaultRollbackRetry,
        onFailure: handler.onFailure ?? this.options.onFailure,
        mode: "settle",
        settleError: error,
      })
      await runtime.run(handler.run)
      this.reaper.kick()
    } catch (settleError) {
      // The instance stays `compensating` with a failed job — surfaced by the
      // dashboard's stuck detection and recoverable via its retry action.
      console.error(
        `bullmq-durable: stall settlement failed for job ${String(job?.id)}:`,
        settleError,
      )
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

  /** Close the worker and any store we created. */
  async close(): Promise<void> {
    await this.bullWorker.close()
    if (this.ownsStore) await this.store.close()
  }
}

/**
 * Build the BullMQ `WorkerOptions` from a {@link DurableWorkerOptions}: strip
 * the durable-only fields, fold in deprecated aliases (with one-shot warnings),
 * and pass everything else through untouched.
 */
export function buildWorkerOptions(options: DurableWorkerOptions): WorkerOptions {
  const {
    stateStore: _stateStore,
    durablePrefix: _durablePrefix,
    defaultStepOptions: _steps,
    defaultRollbackRetry: _rollback,
    onFailure: _onFailure,
    bullPrefix,
    lockTimeout,
    retention,
    maxLogs,
    resumeAttempts,
    bullWorkerOptions,
    ...workerOptions
  } = options

  if (bullPrefix !== undefined) {
    warnOnce("worker.bullPrefix", "`bullPrefix` is deprecated — use `prefix` (BullMQ's own).")
  }
  if (lockTimeout !== undefined) {
    warnOnce(
      "worker.lockTimeout",
      "`lockTimeout` is deprecated and ignored — the instance lock is internal; " +
        "tune BullMQ's `lockDuration`/`stalledInterval` instead.",
    )
  }
  if (retention !== undefined) {
    warnOnce(
      "worker.retention",
      "`retention` is deprecated and ignored — durable state now lives exactly as long " +
        "as its job; govern the run with `removeOnComplete`/`removeOnFail`.",
    )
  }
  if (maxLogs !== undefined) {
    warnOnce(
      "worker.maxLogs",
      "`maxLogs` is deprecated and ignored — logs live in the BullMQ job log; " +
        "bound them with `defaultJobOptions.keepLogs`.",
    )
  }
  if (resumeAttempts !== undefined) {
    warnOnce("worker.resumeAttempts", "`resumeAttempts` is deprecated — there are no resume jobs.")
  }
  if (bullWorkerOptions !== undefined) {
    warnOnce(
      "worker.bullWorkerOptions",
      "`bullWorkerOptions` is deprecated — durable worker options ARE BullMQ WorkerOptions; " +
        "put those fields at the top level.",
    )
  }

  return {
    ...bullWorkerOptions,
    ...workerOptions,
    prefix: workerOptions.prefix ?? bullPrefix ?? bullWorkerOptions?.prefix,
  }
}

/**
 * Translate a {@link RunOutcome} into BullMQ semantics — the four words the
 * bull worker understands. Exported for unit testing.
 */
export function runOutcomeToReturn(outcome: RunOutcome, instanceId: string): unknown {
  switch (outcome.type) {
    case "completed":
      return outcome.output
    case "suspended":
      // The job was moveToDelayed'd (or belongs to another holder): tell the
      // bull worker to leave it exactly where it is.
      throw new DelayedError()
    case "retriable":
      // Non-step error with job attempts remaining: BullMQ's own attempts /
      // backoff schedule the re-delivery.
      throw outcome.error
    case "failed":
      // Terminal: compensation/onFailure already ran (or the stored failure was
      // replayed). UnrecoverableError semantics stop further attempts.
      throw new DurableTerminalJobError(errorMessage(outcome.error), outcome.error)
    case "cancelled":
      throw new DurableCancelledJobError(instanceId)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : "durable run failed"
}

function annotateDurableId(job: Job, instanceId: string): void {
  Object.defineProperty(job, "durableId", {
    value: instanceId,
    enumerable: false,
    configurable: true,
  })
}

/** A resolved per-job handler: the forward processor + optional failure hook. */
export interface ResolvedDurableHandler {
  run: DurableProcessor
  onFailure?: DurableFailureHandler
}

/**
 * Resolve the `{ run, onFailure }` for a job name — accepting a single function
 * (handles every job), a TOP-LEVEL `{ run, onFailure }` (the worker's default
 * handler, job name ignored), a per-name function, or a per-name
 * `{ run, onFailure }` object. `run` is a reserved word in the map form: a
 * job actually named "run" uses the object entry (`{ run: { run: fn } }`).
 * Exported for unit testing.
 */
export function resolveDurableHandler(
  input: DurableProcessorInput,
  jobName: string,
  queueName: string,
): ResolvedDurableHandler {
  if (typeof input === "function") {
    return { run: input as DurableProcessor }
  }
  // Top-level default handler: `{ run, onFailure }` with `run` a function.
  // (A handler MAP whose "run" job uses the object form falls through — its
  // `run` property is an object, not a function.)
  if (typeof (input as DurableJobHandler).run === "function") {
    const handler = input as DurableJobHandler
    return {
      run: handler.run as DurableProcessor,
      onFailure: handler.onFailure as DurableFailureHandler | undefined,
    }
  }
  const entry = (input as DurableProcessorHandlers)[jobName]
  if (!entry) {
    throw new Error(
      `DurableWorker: no processor registered for job "${jobName}" on queue "${queueName}"`,
    )
  }
  if (typeof entry === "function") {
    return { run: entry as DurableProcessor }
  }
  return {
    run: entry.run as DurableProcessor,
    onFailure: entry.onFailure as DurableFailureHandler | undefined,
  }
}

/**
 * Pick the processor function for a job name. Retained for back-compat;
 * delegates to {@link resolveDurableHandler}. Exported for unit testing.
 */
export function resolveDurableProcessor(
  input: DurableProcessorInput,
  jobName: string,
  queueName: string,
): DurableProcessor {
  return resolveDurableHandler(input, jobName, queueName).run
}
