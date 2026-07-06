/**
 * DurableInspector — the cockpit's thin adapter over `bullmq-durable`'s public
 * object model: one {@link DurableQueue} per queue (reusing the cockpit's
 * BullMQ `Queue` instances and one shared state store), {@link DurableRun}
 * handles for run-scoped reads and actions.
 *
 * Since 0.2.0 the runtime package exposes every read and action the dashboard
 * needs (list windows, summaries, logs/events, resume/retry/cancel/delete with
 * the legacy-carrier fallback built in). This class only does what is
 * genuinely dashboard-shaped: cross-queue aggregation, wire-DTO projection,
 * list filtering/sorting/pagination, and HTTP error mapping. No Redis-layout
 * knowledge lives here.
 */

import {
  DurableActionError,
  DurableQueue,
  RedisStateStore,
  summarizeInstances,
} from "bullmq-durable"
import type { DurableCarrierState, DurableRun, InstanceState } from "bullmq-durable"
import type { Queue } from "bullmq"
import type { Redis } from "ioredis"
import type {
  DurableEvent,
  DurableInstanceDetail,
  DurableInstanceList,
  DurableInstanceSummary,
  DurableLogEntry,
  DurableStatusCounts,
  DurableStep,
} from "../../shared/dto"
import { toInstanceDetail, toInstanceSummary, toStep } from "../durable/derive"
import { badRequest, notFound } from "../http/http-error"

export interface DurableInstanceQuery {
  status?: string
  queue?: string
  jobName?: string
  search?: string
  stuckOnly?: boolean
  sort?: "updatedAt" | "createdAt" | "duration"
  order?: "asc" | "desc"
  page: number
  pageSize: number
}

export interface DurableInspectorDeps {
  redis: Redis
  prefix: string
  stuckThresholdMs: number
  getQueue: (name: string) => Queue
}

/** The terminal statuses, as `listRuns` kinds. */
const TERMINAL_STATUSES = ["completed", "failed", "compensation_failed", "cancelled"] as const

/** Max ids loaded per terminal bucket per queue when listing. Pagination beyond
 *  this window is reported as `truncated` — the list never falls back to a scan. */
const LIST_HARD_CAP = 2000

/** Single-flight window for the active-population summary (overview + health). */
const ACTIVE_SUMMARIES_TTL_MS = 2_000

/** A zeroed count histogram, spread into every {@link DurableStatusCounts}. */
const EMPTY_COUNTS = {
  running: 0,
  sleeping: 0,
  retrying: 0,
  waiting: 0,
  compensating: 0,
  completed: 0,
  failed: 0,
  compensation_failed: 0,
  cancelled: 0,
  stuck: 0,
  total: 0,
} as const

export class DurableInspector {
  /** One shared store for every queue's durable state (one Redis client). */
  private readonly store: RedisStateStore
  private readonly getQueue: (name: string) => Queue
  private readonly durableQueues = new Map<string, DurableQueue>()
  private readonly thresholdMs: number

  constructor(deps: DurableInspectorDeps) {
    this.thresholdMs = deps.stuckThresholdMs
    this.getQueue = deps.getQueue
    // RedisStateStore duplicates the client so scans never contend.
    this.store = new RedisStateStore({ connection: deps.redis, prefix: deps.prefix })
  }

  async close(): Promise<void> {
    // The queues hold only injected resources (the cockpit's bull queues + our
    // shared store); closing them is a formality, the store is ours to close.
    await Promise.allSettled([...this.durableQueues.values()].map((q) => q.close()))
    this.durableQueues.clear()
    await this.store.close()
  }

  // -- Object-model access ----------------------------------------------------

  /** The durable view of one queue, reusing the cockpit's bull `Queue`. */
  private queueFor(name: string): DurableQueue {
    let queue = this.durableQueues.get(name)
    if (!queue) {
      queue = new DurableQueue(name, {
        connection: {} as never, // never dialed: both store and bullmq are injected
        stateStore: this.store,
        bullmq: this.getQueue(name),
      })
      this.durableQueues.set(name, queue)
    }
    return queue
  }

  /** Every queue in the durable registry. */
  private async queueNames(): Promise<string[]> {
    return this.store.queues()
  }

  /**
   * Resolve an instance id to its run handle WITHOUT parsing the id (ids are
   * opaque): the instance state names its queue and job.
   */
  private async resolveRun(instanceId: string): Promise<DurableRun | null> {
    const state = await this.store.getInstance(instanceId)
    if (!state) return null
    return this.queueFor(state.queueName).run(state.originalJobId, state)
  }

  /** The carrier job's BullMQ state for a run (health checks). */
  async carrierState(queueName: string, jobId: string): Promise<DurableCarrierState> {
    return this.queueFor(queueName).run(jobId).carrierState()
  }

  // -- Reads ---------------------------------------------------------------

  /**
   * List instances WITHOUT a full scan: each queue loads candidates from its
   * status index (the bounded active population for non-terminal / stuck
   * filters; the relevant terminal bucket(s), newest first, for finished
   * ones), then this adapter filters / sorts / paginates in memory.
   */
  async listInstances(query: DurableInstanceQuery): Promise<DurableInstanceList> {
    const page = Math.max(1, query.page)
    const status = query.status
    const isTerminal = (TERMINAL_STATUSES as readonly string[]).includes(status ?? "")

    // Terminal statuses get REAL pagination (zset offset pages), not a window.
    if (isTerminal && !query.stuckOnly) {
      return this.listTerminalInstances(status as (typeof TERMINAL_STATUSES)[number], query, page)
    }

    // Non-terminal / mixed listings read the (bounded) active population,
    // optionally plus terminal windows for "all".
    const kind = query.stuckOnly || (status && status !== "all") ? "active" : "all"
    const window = Math.min(page * query.pageSize + query.pageSize, LIST_HARD_CAP)
    const pages = await Promise.all(
      (await this.queueNames()).map((name) => this.queueFor(name).listRuns({ kind, window })),
    )
    const indexTotal = pages.reduce((sum, p) => sum + p.indexTotal, 0)
    const truncated = pages.some((p) => p.truncated)
    const windowed = pages.some((p) => p.windowed)

    let summaries = await this.summarize(pages.flatMap((p) => p.runs))
    summaries = this.applyFilters(summaries, query)
    summaries = this.applySort(summaries, query)

    // `total` must be the real cardinality so the client's page count is stable.
    // When a terminal bucket is windowed, the index count is exact — unless a
    // secondary in-memory filter narrows it, where only the loaded count is
    // knowable and `truncated` signals "recent only".
    const narrowed = Boolean(query.search || query.queue || query.jobName)
    const total = windowed && !narrowed ? indexTotal : summaries.length

    const start = (page - 1) * query.pageSize
    return {
      items: summaries.slice(start, start + query.pageSize),
      total,
      page,
      pageSize: query.pageSize,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  /**
   * Terminal-status listing via `listRunsPage` — the runtime's exact offset
   * pages over one done bucket. With a single queue and the default recency
   * sort the offset is pushed all the way down to Redis (exact deep
   * pagination, no cap); across queues, exact per-queue pages are merged and
   * sliced.
   */
  private async listTerminalInstances(
    status: (typeof TERMINAL_STATUSES)[number],
    query: DurableInstanceQuery,
    page: number,
  ): Promise<DurableInstanceList> {
    const names = query.queue ? [query.queue] : await this.queueNames()
    if (names.length === 0) {
      return { items: [], total: 0, page, pageSize: query.pageSize }
    }

    const recencySort = (query.sort ?? "updatedAt") === "updatedAt"
    const pushdown = names.length === 1 && recencySort && !query.search && !query.jobName
    if (pushdown) {
      const result = await this.queueFor(names[0]!).listRunsPage({
        kind: status,
        offset: (page - 1) * query.pageSize,
        limit: query.pageSize,
        order: query.order ?? "desc",
      })
      return {
        items: await this.summarize(result.runs),
        total: result.total,
        page,
        pageSize: query.pageSize,
      }
    }

    // Merge path: exact newest-first pages per queue, deep enough to cover the
    // requested global slice, then filter/sort/slice in memory.
    const need = Math.min(page * query.pageSize + query.pageSize, LIST_HARD_CAP)
    const pages = await Promise.all(
      names.map((name) =>
        this.queueFor(name).listRunsPage({ kind: status, offset: 0, limit: need, order: "desc" }),
      ),
    )
    let summaries = await this.summarize(pages.flatMap((p) => p.runs))
    summaries = this.applyFilters(summaries, query)
    summaries = this.applySort(summaries, query)

    const bucketTotal = pages.reduce((sum, p) => sum + p.total, 0)
    const narrowed = Boolean(query.search || query.jobName)
    const truncated = pages.some((p) => p.total > need)
    const start = (page - 1) * query.pageSize
    return {
      items: summaries.slice(start, start + query.pageSize),
      total: narrowed ? summaries.length : bucketTotal,
      page,
      pageSize: query.pageSize,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  /** Derived-status counts for the overview — index reads only, never a scan. */
  async statusCounts(): Promise<DurableStatusCounts> {
    const [countsPerQueue, active] = await Promise.all([
      this.queueNames().then((names) =>
        Promise.all(names.map((name) => this.queueFor(name).countRuns())),
      ),
      this.activeSummaries(),
    ])

    const counts: DurableStatusCounts = { ...EMPTY_COUNTS }
    for (const c of countsPerQueue) {
      counts.completed += c.completed
      counts.failed += c.failed
      counts.compensation_failed += c.compensation_failed
      counts.cancelled += c.cancelled
      counts.total += c.completed + c.failed + c.compensation_failed + c.cancelled
    }
    counts.total += active.length
    for (const s of active) {
      // The active population is non-terminal, so this only bumps
      // running/sleeping/retrying/waiting/compensating.
      counts[s.derivedStatus] += 1
      if (s.stuck) counts.stuck += 1
    }
    return counts
  }

  /** Hydrate + summarize the bounded active (non-terminal) population. Shared
   *  by the overview counts and the health inspector's stuck detection —
   *  which poll on the same cycle, so a short single-flight cache halves the
   *  Redis work without meaningful staleness on a dashboard. */
  async activeSummaries(): Promise<DurableInstanceSummary[]> {
    const now = Date.now()
    if (this.activeCache && now - this.activeCache.at < ACTIVE_SUMMARIES_TTL_MS) {
      return this.activeCache.promise
    }
    const promise = this.loadActiveSummaries().catch((error: unknown) => {
      this.activeCache = undefined // never cache a failure
      throw error
    })
    this.activeCache = { at: now, promise }
    return promise
  }

  private activeCache?: { at: number; promise: Promise<DurableInstanceSummary[]> }

  private async loadActiveSummaries(): Promise<DurableInstanceSummary[]> {
    const runsPerQueue = await Promise.all(
      (await this.queueNames()).map((name) => this.queueFor(name).activeRuns()),
    )
    return this.summarize(runsPerQueue.flat())
  }

  /** Cross-queue batch summarize: one lock probe for the whole set. */
  private async summarize(runs: DurableRun[]): Promise<DurableInstanceSummary[]> {
    const instances = runs
      .map((run) => run.snapshot)
      .filter((state): state is InstanceState => Boolean(state))
    const summaries = await summarizeInstances(this.store, instances, {
      stuckThresholdMs: this.thresholdMs,
    })
    const now = Date.now()
    return summaries.map((s) => ({
      ...toInstanceSummary(s.instance, s.steps, now, this.thresholdMs),
      // summarizeInstances already suppressed running_stale under a live lock.
      stuck: s.stuck,
    }))
  }

  async getInstance(instanceId: string): Promise<DurableInstanceDetail | null> {
    const run = await this.resolveRun(instanceId)
    if (!run?.snapshot) return null
    const steps = await run.steps()
    return toInstanceDetail(run.snapshot, steps, Date.now(), this.thresholdMs)
  }

  async getSteps(instanceId: string): Promise<DurableStep[]> {
    const run = await this.resolveRun(instanceId)
    if (!run) return []
    const now = Date.now()
    return (await run.steps()).map((s) => toStep(s, now))
  }

  async getLogs(instanceId: string): Promise<DurableLogEntry[]> {
    const run = await this.resolveRun(instanceId)
    return run ? run.logs() : []
  }

  async getEvents(instanceId: string): Promise<DurableEvent[]> {
    const run = await this.resolveRun(instanceId)
    return run ? run.events() : []
  }

  /** Of the given instance ids, which actually exist? */
  async existing(instanceIds: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    const loaded = await this.store.getInstances(instanceIds)
    loaded.forEach((instance, index) => {
      if (instance) found.add(instanceIds[index]!)
    })
    return found
  }

  // -- Actions (run methods + HTTP error mapping) ----------------------------

  async resumeNow(instanceId: string): Promise<void> {
    await this.action(instanceId, (run) => run.resume())
  }

  async retry(instanceId: string): Promise<void> {
    await this.action(instanceId, (run) => run.retry())
  }

  async retryCompensation(instanceId: string): Promise<void> {
    await this.action(instanceId, (run) => run.retryCompensation())
  }

  async cancel(instanceId: string): Promise<void> {
    await this.action(instanceId, (run) => run.cancel())
  }

  async deleteState(instanceId: string): Promise<void> {
    await this.action(instanceId, (run) => run.delete())
  }

  private async action(
    instanceId: string,
    invoke: (run: DurableRun) => Promise<void>,
  ): Promise<void> {
    const run = await this.resolveRun(instanceId)
    if (!run) throw notFound(`Durable instance "${instanceId}" not found`)
    await this.runAction(run, invoke)
  }

  /** Run one durable action, mapping {@link DurableActionError} onto HTTP errors. */
  private async runAction(
    run: DurableRun,
    invoke: (run: DurableRun) => Promise<void>,
  ): Promise<void> {
    try {
      await invoke(run)
    } catch (error) {
      if (error instanceof DurableActionError) {
        throw error.code === "not_found" ? notFound(error.message) : badRequest(error.message)
      }
      throw error
    }
  }

  // -- Durable-aware routing for the BullMQ surfaces --------------------------
  // The plain queue/job inspectors route through these when durable is enabled,
  // so maintenance done from the BullMQ pages keeps run state in lockstep with
  // the jobs (state follows the job). Queues without durable state pass through
  // unchanged — the durable follow-ups are no-ops on an empty index.

  /** `Queue.drain` + reconcile/reap of the orphaned non-terminal run state. */
  async drainQueue(queueName: string): Promise<void> {
    await this.queueFor(queueName).drain()
  }

  /** `Queue.clean` + exact state removal for the cleaned jobs. */
  async cleanQueue(
    queueName: string,
    graceMs: number,
    limit: number,
    status?: Parameters<Queue["clean"]>[2],
  ): Promise<void> {
    await this.queueFor(queueName).clean(graceMs, limit, status)
  }

  /**
   * Durable-aware job retry: a run in a terminal-failure status is re-driven
   * through the runtime — a bare `job.retry()` would only replay the stored
   * failure without re-running any business code. Returns `false` when the job
   * carries no such run (including non-terminal ones, where the plain BullMQ
   * retry IS the correct continuation) — the caller falls back.
   */
  async retryRun(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.queueFor(queueName)
    const state = await this.store.getInstance(queue.instanceIdFor(jobId))
    if (state?.status !== "failed" && state?.status !== "compensation_failed") return false
    // Unseeded handle: the action re-reads state, so a concurrent transition
    // surfaces as invalid_state instead of acting on a stale snapshot.
    await this.runAction(queue.run(jobId), (run) =>
      state.status === "failed" ? run.retry() : run.retryCompensation(),
    )
    return true
  }

  /**
   * Durable-aware job removal: a job that carries a run is deleted through the
   * runtime (state + carrier jobs), so no orphan state lingers. Returns `false`
   * when the job has no durable state — the caller falls back to a plain
   * `job.remove()`.
   */
  async deleteRun(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.queueFor(queueName)
    const state = await this.store.getInstance(queue.instanceIdFor(jobId))
    if (!state) return false
    await this.runAction(queue.run(jobId, state), (run) => run.delete())
    return true
  }

  // -- Internals -----------------------------------------------------------

  private applyFilters(
    summaries: DurableInstanceSummary[],
    query: DurableInstanceQuery,
  ): DurableInstanceSummary[] {
    const search = query.search?.toLowerCase().trim()
    return summaries.filter((s) => {
      if (query.status && query.status !== "all" && s.derivedStatus !== query.status) return false
      if (query.queue && s.queueName !== query.queue) return false
      if (query.jobName && s.jobName !== query.jobName) return false
      if (query.stuckOnly && !s.stuck) return false
      if (search) {
        const haystack = `${s.id} ${s.businessId} ${s.jobName} ${s.queueName}`.toLowerCase()
        if (!haystack.includes(search)) return false
      }
      return true
    })
  }

  private applySort(
    summaries: DurableInstanceSummary[],
    query: DurableInstanceQuery,
  ): DurableInstanceSummary[] {
    const dir = query.order === "asc" ? 1 : -1
    const field = query.sort ?? "updatedAt"
    return [...summaries].sort((a, b) => {
      const av = field === "duration" ? (a.durationMs ?? 0) : a[field]
      const bv = field === "duration" ? (b.durationMs ?? 0) : b[field]
      return (av - bv) * dir
    })
  }
}
