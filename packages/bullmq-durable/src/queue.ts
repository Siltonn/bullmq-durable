/**
 * {@link DurableQueue} — a thin, type-safe wrapper around a BullMQ `Queue`,
 * and the owner of this queue's run collection: it vends {@link DurableRun}
 * handles (`run` / `getRun`) and carries the collection-level reads
 * (`listRuns` / `countRuns` / `activeRuns` / `summarizeRuns`), mirroring how a
 * BullMQ `Queue` relates to its `Job`s.
 *
 * Adding a job is intentionally identical to BullMQ: the durable instance is
 * created lazily on the worker's first tick, not at enqueue time. This keeps
 * `add` cheap and avoids a double-write where the job is enqueued but state
 * initialisation fails.
 *
 * State follows the job: the bulk-removal methods (`clean` / `drain` /
 * `obliterate`) are overridden to pass through to BullMQ and then delete the
 * matching durable state, so bulk queue maintenance never strands run records.
 *
 * The underlying BullMQ queue and state store are created lazily so that simply
 * constructing a `DurableQueue` (e.g. in a DI container) does not open a Redis
 * connection until it is actually used.
 */

import { type JobsOptions, Queue, type QueueEvents, type QueueOptions } from "bullmq"
import { summarizeInstances, type DurableRunSummary, type SummarizeOptions } from "./inspect/summarize"
import { bullJobsExist, DurableReaper, wireQueueEvents } from "./reaper"
import { DurableRun, removeCarrierJobs, type DurableRunContext } from "./run"
import { RedisStateStore } from "./store/redis-store"
import type { StateStore } from "./store/state-store"
import type {
  DurableJob,
  DurableLogEntry,
  DurableQueueOptions,
  InstanceState,
  StepState,
} from "./types"
import { warnOnce } from "./utils/deprecations"
import {
  createInstanceId,
  DEFAULT_DURABLE_PREFIX,
  TERMINAL_STATUSES,
  type TerminalStatus,
} from "./utils/keys"

/** Which index population `listRuns` reads. */
export type DurableRunListKind = "active" | "all" | TerminalStatus

export interface DurableRunListQuery {
  kind: DurableRunListKind
  /**
   * Max ids loaded per terminal bucket, newest first. The active population is
   * always loaded in full (it is bounded by in-flight work).
   */
  window: number
}

export interface DurableRunPage {
  /** Run handles with their {@link DurableRun.snapshot} populated. */
  runs: DurableRun[]
  /** Exact index cardinality of the selected population (before hydration). */
  indexTotal: number
  /** True when some terminal bucket held more than the loaded window. */
  truncated: boolean
  /** True when a terminal bucket was windowed (list semantics, not exact page). */
  windowed: boolean
}

/** Per-status run counts for one queue — index reads only, never a scan. */
export interface DurableRunCounts {
  active: number
  completed: number
  failed: number
  compensation_failed: number
  cancelled: number
}

export class DurableQueue<TData = any, TResult = any, TName extends string = string> {
  private queue?: Queue
  private ownsBull = false
  private store?: StateStore
  private ownsStore = false
  private reaperInstance?: DurableReaper
  private runCtx?: DurableRunContext
  private readonly queueEventCleanups: Array<() => void> = []

  constructor(
    readonly name: string,
    private readonly options: DurableQueueOptions,
  ) {}

  /** The Redis key prefix for durable state. */
  private get durablePrefix(): string {
    return this.options.durablePrefix ?? DEFAULT_DURABLE_PREFIX
  }

  /** Lazily resolve the underlying BullMQ queue (injected one if provided). */
  get bull(): Queue {
    if (!this.queue) {
      if (this.options.bull) {
        this.queue = this.options.bull
      } else {
        this.queue = new Queue(this.name, buildQueueOptions(this.options))
        this.ownsBull = true
      }
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

  private get reaper(): DurableReaper {
    if (!this.reaperInstance) {
      this.reaperInstance = new DurableReaper({
        store: this.stateStore,
        queueName: this.name,
        jobsExist: bullJobsExist(this.bull),
      })
    }
    return this.reaperInstance
  }

  /** What every {@link DurableRun} handle borrows from its owning queue. */
  private get runContext(): DurableRunContext {
    if (!this.runCtx) {
      const self = this
      this.runCtx = {
        queueName: this.name,
        get store() {
          return self.stateStore
        },
        bull: () => self.bull,
        kickReaper: () => self.reaper.kick(),
      }
    }
    return this.runCtx
  }

  /**
   * Enqueue a durable job. Mirrors `Queue.add`: the job `name` is a free routing
   * label (like BullMQ), and the payload is typed by the queue's `TData`. The
   * returned job is a {@link DurableJob} annotated with its instance id.
   */
  async add(
    name: TName,
    data: TData,
    opts?: JobsOptions,
  ): Promise<DurableJob<TData, TResult, TName>> {
    const job = await this.bull.add(name, data, opts)
    return annotateDurable(job, createInstanceId(this.name, job.id ?? "")) as DurableJob<
      TData,
      TResult,
      TName
    >
  }

  // -- Runs (the collection; single-run reads/actions live on DurableRun) ---

  /** The durable instance id for a given job id. */
  instanceIdFor(jobId: string | number): string {
    return createInstanceId(this.name, jobId)
  }

  /**
   * A cheap {@link DurableRun} handle for a job — like `Job.fromId` without the
   * fetch. Pass a prefetched state as `snapshot` to seed it; otherwise the
   * run's reads fetch on demand.
   */
  run(jobId: string | number, snapshot?: InstanceState): DurableRun {
    return new DurableRun(this.runContext, jobId, snapshot)
  }

  /** The run for a job, with its state loaded — `null` when it has none. */
  async getRun(jobId: string | number): Promise<DurableRun | null> {
    const run = this.run(jobId)
    return (await run.state()) ? run : null
  }

  /**
   * Load a window of this queue's runs from the status index — never a scan.
   * Terminal buckets are read newest-first up to `window`; the active
   * population is always loaded in full. Ids whose state hash is gone
   * self-heal out of the index.
   */
  async listRuns(query: DurableRunListQuery): Promise<DurableRunPage> {
    const wantActive = query.kind === "active" || query.kind === "all"
    const buckets: readonly TerminalStatus[] =
      query.kind === "all" ? TERMINAL_STATUSES : query.kind === "active" ? [] : [query.kind]

    const ids = new Set<string>()
    let indexTotal = 0
    let truncated = false

    if (wantActive) {
      const active = await this.stateStore.listActive(this.name)
      for (const id of active) ids.add(id)
      indexTotal += active.length
    }
    for (const status of buckets) {
      const [members, total] = await Promise.all([
        this.stateStore.listNewestTerminal(this.name, status, query.window),
        this.stateStore.countTerminal(this.name, status),
      ])
      for (const id of members) ids.add(id)
      indexTotal += total
      if (total > members.length) truncated = true
    }

    const idList = [...ids]
    const loaded = await this.stateStore.getInstances(idList)
    const runs: DurableRun[] = []
    const gone: string[] = []
    loaded.forEach((instance, index) => {
      if (instance) runs.push(this.run(instance.originalJobId, instance))
      else gone.push(idList[index]!)
    })
    // Read-time index self-heal for phantom entries (best effort).
    if (gone.length > 0) {
      void this.stateStore.removeInstances(this.name, gone).catch(() => undefined)
    }

    return { runs, indexTotal, truncated, windowed: buckets.length > 0 }
  }

  /** The full (bounded) non-terminal population, snapshots loaded. */
  async activeRuns(): Promise<DurableRun[]> {
    return (await this.listRuns({ kind: "active", window: 0 })).runs
  }

  /** Per-status run counts — pure index reads (`SCARD`/`ZCARD` semantics). */
  async countRuns(): Promise<DurableRunCounts> {
    const counts: DurableRunCounts = {
      active: (await this.stateStore.listActive(this.name)).length,
      completed: 0,
      failed: 0,
      compensation_failed: 0,
      cancelled: 0,
    }
    for (const status of TERMINAL_STATUSES) {
      counts[status] = await this.stateStore.countTerminal(this.name, status)
    }
    return counts
  }

  /**
   * Batch-summarize runs (steps + derived view + stuck classification) — one
   * lock probe for the lot; single-run callers use `run.summary()`.
   */
  async summarizeRuns(runs: DurableRun[], options: SummarizeOptions): Promise<DurableRunSummary[]> {
    const instances: InstanceState[] = []
    for (const run of runs) {
      const instance = run.snapshot ?? (await run.state())
      if (instance) instances.push(instance)
    }
    return summarizeInstances(this.stateStore, instances, options)
  }

  /** Reconcile + reap now: collect state whose job is gone, cancel orphans. */
  async reconcile(): Promise<void> {
    await this.reaper.pass(true)
  }

  // -- Per-job conveniences (delegate to the run entity) ---------------------

  /** Read the durable instance state for a job. */
  async getDurableState(jobId: string | number): Promise<InstanceState | null> {
    return this.run(jobId).state()
  }

  /** Read all recorded steps for a job. */
  async getDurableSteps(jobId: string | number): Promise<StepState[]> {
    return this.run(jobId).steps()
  }

  /**
   * Read the durable logs for a job — parsed from the BullMQ job log (where
   * `ctx.log` writes them). Once the job is cleaned away, its logs are gone
   * too; this returns `[]` then.
   */
  async getDurableLogs(jobId: string | number): Promise<DurableLogEntry[]> {
    return this.run(jobId).logs()
  }

  /**
   * Cancel a durable run — the lenient, application-side path: idempotent,
   * works even before the first tick has created state (the cancelled marker
   * makes that tick stop immediately). Dashboards wanting strict state
   * validation use `run.cancel()` instead.
   *
   * Removal is by exact id, never a scan. Correctness does not rely on it: a
   * tick that still fires observes the cancelled status and stops.
   */
  async cancel(jobId: string | number): Promise<void> {
    const instanceId = this.instanceIdFor(jobId)
    const instance = await this.stateStore.getInstance(instanceId)
    await this.stateStore.cancelInstance(instanceId)
    // Best effort — the instance is already marked cancelled either way. The
    // helper also covers a 0.1.x legacy resume-job carrier (removed in 0.3.0).
    await removeCarrierJobs(this.bull, {
      originalJobId: instance?.originalJobId ?? String(jobId),
      ...(instance?.resumeSeq !== undefined ? { resumeSeq: instance.resumeSeq } : {}),
    })
  }

  // -- Bulk maintenance (state follows the job) ------------------------------

  /**
   * `Queue.clean` pass-through that also deletes the durable state of every
   * removed job — BullMQ returns the removed ids, so the follow-up is exact.
   */
  async clean(
    graceMs: number,
    limit: number,
    type?: Parameters<Queue["clean"]>[2],
  ): Promise<string[]> {
    const removed = await this.bull.clean(graceMs, limit, type)
    if (removed.length > 0) {
      await this.stateStore.removeInstances(
        this.name,
        removed.map((id) => this.instanceIdFor(id)),
      )
    }
    return removed
  }

  /**
   * `Queue.drain` pass-through. Drain reports neither ids nor events, so the
   * durable follow-up is a reconcile: non-terminal instances whose job vanished
   * are cancelled and reaped.
   */
  async drain(delayed?: boolean): Promise<void> {
    await this.bull.drain(delayed)
    await this.reaper.pass(true)
  }

  /**
   * `Queue.obliterate` pass-through that wipes ALL durable state for this
   * queue — index-driven (active set + done buckets), no key scan.
   */
  async obliterate(opts?: Parameters<Queue["obliterate"]>[0]): Promise<void> {
    await this.bull.obliterate(opts)
    await this.stateStore.wipeQueue(this.name)
  }

  /**
   * Reuse a host-provided `QueueEvents` as the real-time layer of
   * state-follows-job (see the worker's counterpart). Optional accelerator —
   * correctness never depends on it.
   */
  attachQueueEvents(queueEvents: QueueEvents): this {
    this.queueEventCleanups.push(
      wireQueueEvents(queueEvents, this.reaper, (jobId) => this.instanceIdFor(jobId)),
    )
    return this
  }

  /** Close whatever this queue opened itself (injected resources stay open). */
  async close(): Promise<void> {
    for (const cleanup of this.queueEventCleanups.splice(0)) cleanup()
    if (this.queue && this.ownsBull) await this.queue.close()
    if (this.store && this.ownsStore) await this.store.close()
  }
}

/**
 * Build the BullMQ `QueueOptions` from a {@link DurableQueueOptions}: strip the
 * durable-only fields, fold in deprecated aliases (with one-shot warnings), and
 * pass everything else through untouched.
 */
export function buildQueueOptions(options: DurableQueueOptions): QueueOptions {
  const {
    stateStore: _stateStore,
    durablePrefix: _durablePrefix,
    bull: _bull,
    bullPrefix,
    resumeAttempts,
    ...queueOptions
  } = options

  if (bullPrefix !== undefined) {
    warnOnce("queue.bullPrefix", "`bullPrefix` is deprecated — use `prefix` (BullMQ's own).")
  }
  if (resumeAttempts !== undefined) {
    warnOnce("queue.resumeAttempts", "`resumeAttempts` is deprecated — there are no resume jobs.")
  }

  return {
    ...queueOptions,
    prefix: queueOptions.prefix ?? bullPrefix,
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
