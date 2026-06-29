/**
 * DurableInspector — reads and acts on `bullmq-durable` instance state.
 *
 * It talks to Redis directly through the documented durable protocol (see
 * `../durable/protocol.ts`); the runtime itself is never imported. Mutating
 * actions (resume / retry / cancel / delete) write through the *same* protocol,
 * so the cockpit behaves as a well-behaved peer of the runtime:
 *
 *  - **Resume** allocates a fresh `resumeSeq` (so the resume job id is unique)
 *    and enqueues a zero-delay tick. Replays are idempotent, so this is safe.
 *  - **Retry** lifts a failed instance off its terminal status so the next tick
 *    re-executes the failed step (completed steps stay cached).
 *  - **Cancel** flags the instance and best-effort removes the pending tick.
 *  - **Delete** drops durable state only — never business data or BullMQ jobs.
 */

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
import { synthesizeEvents, toInstanceDetail, toStep } from "../durable/derive"
import {
  activeIndexKey,
  DEFAULT_RETENTION_MS,
  DURABLE_META_KEY,
  instanceKey,
  logsKey,
  lockKey,
  parseInstanceHash,
  parseLog,
  parseStep,
  resumeJobId,
  stepsKey,
  terminalIndexKey,
  type StoredInstanceState,
  type StoredStepState,
  type TerminalStatus,
} from "../durable/protocol"
import { badRequest, notFound } from "../http/http-error"

const MAX_COCKPIT_LOGS = 1000

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

/** Statuses whose derived view depends on their steps. */
const STEP_HUNGRY = new Set(["running", "yielded", "failed"])

/** The terminal statuses, in their fixed index-bucket order. */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const

/** Max ids loaded per terminal bucket when listing. Pagination beyond this
 *  window is reported as `truncated` — the list never falls back to a full scan. */
const LIST_HARD_CAP = 2000

/** A zeroed count histogram, spread into every {@link DurableStatusCounts}. */
const EMPTY_COUNTS = {
  running: 0,
  sleeping: 0,
  retrying: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  stuck: 0,
  total: 0,
} as const

export class DurableInspector {
  private readonly redis: Redis
  private readonly prefix: string
  private readonly thresholdMs: number
  private readonly getQueue: (name: string) => Queue

  constructor(deps: DurableInspectorDeps) {
    this.redis = deps.redis
    this.prefix = deps.prefix
    this.thresholdMs = deps.stuckThresholdMs
    this.getQueue = deps.getQueue
  }

  // -- Reads ---------------------------------------------------------------

  /**
   * List instances WITHOUT a full scan: load candidate ids from the index (the
   * bounded active set for non-terminal / stuck filters; the relevant terminal
   * bucket(s) via `ZREVRANGE` for finished ones), hydrate only those, then
   * filter / sort / paginate in memory. Deep pagination past the load window is
   * reported as `truncated` (recent instances only).
   */
  async listInstances(query: DurableInstanceQuery): Promise<DurableInstanceList> {
    const page = Math.max(1, query.page)
    const { instances, truncated, indexTotal, windowed } = await this.loadListCandidates(query, page)
    let summaries = await this.summarizeInstances(instances)
    summaries = this.applyFilters(summaries, query)
    summaries = this.applySort(summaries, query)

    // `total` must be the real cardinality so the client's page count is stable
    // (not the loaded-window size, which would grow as you paginate). When a
    // terminal bucket is windowed, the index ZCOUNT is the exact total — unless a
    // secondary in-memory filter (search/queue/jobName) narrows it, where the true
    // filtered total isn't knowable without a scan, so we report the loaded count
    // and let `truncated` signal "recent only". Active-only queries load the whole
    // set, so the filtered length is already exact.
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
   * Load candidate instances for a list query from the index — never a scan. The
   * status filter picks the sources: the bounded active set covers every
   * non-terminal / stuck query; a terminal status reads only its bucket; "all"
   * reads the active set plus every terminal bucket. Buckets are read newest-first
   * up to a window that scales with the requested page (capped at
   * {@link LIST_HARD_CAP}), so shallow pages stay cheap.
   */
  private async loadListCandidates(
    query: DurableInstanceQuery,
    page: number,
  ): Promise<{
    instances: StoredInstanceState[]
    truncated: boolean
    indexTotal: number
    windowed: boolean
  }> {
    const status = query.status
    const isTerminal = status === "completed" || status === "failed" || status === "cancelled"
    let wantActive: boolean
    let buckets: readonly TerminalStatus[]
    if (query.stuckOnly) {
      wantActive = true // "stuck" is always a non-terminal condition
      buckets = []
    } else if (isTerminal) {
      wantActive = false
      buckets = [status as TerminalStatus]
    } else if (!status || status === "all") {
      wantActive = true
      buckets = TERMINAL_STATUSES
    } else {
      wantActive = true // a non-terminal derived status (running/sleeping/retrying/waiting)
      buckets = []
    }

    // Enough of each bucket to cover the requested page after the merge, capped.
    const window = Math.min(page * query.pageSize + query.pageSize, LIST_HARD_CAP)
    const now = Date.now()

    const pipe = this.redis.pipeline()
    if (wantActive) pipe.smembers(activeIndexKey(this.prefix))
    for (const st of buckets) {
      const key = terminalIndexKey(this.prefix, st)
      // Live ids only (score > now), newest-first, READ-ONLY — no prune-on-read.
      pipe.zrevrangebyscore(key, "+inf", `(${now}`, "LIMIT", 0, window)
      pipe.zcount(key, `(${now}`, "+inf") // live cardinality, for total + truncated
    }
    const res = (await pipe.exec()) ?? []

    // Dedup across the active set and the done buckets: an id can briefly appear in
    // both during a transition race, and would otherwise hydrate to a duplicate row.
    const ids = new Set<string>()
    let i = 0
    let indexTotal = 0
    if (wantActive) {
      const activeIds = (res[i++]?.[1] as string[]) ?? []
      for (const id of activeIds) ids.add(id)
      indexTotal += activeIds.length // the whole active set is loaded → exact
    }
    let truncated = false
    for (const _st of buckets) {
      const bucketIds = (res[i++]?.[1] as string[]) ?? []
      const live = Number(res[i++]?.[1] ?? 0)
      for (const id of bucketIds) ids.add(id)
      indexTotal += live
      if (live > bucketIds.length) truncated = true // the bucket holds more than we loaded
    }
    return {
      instances: await this.loadInstancesByIds([...ids]),
      truncated,
      indexTotal,
      windowed: buckets.length > 0,
    }
  }

  /**
   * Derived-status counts for the overview — read from the status index, never a
   * scan. Terminal counts come straight from the index ZCARDs (after a lazy prune
   * of retention-expired ids); the non-terminal breakdown is derived by hydrating
   * the *bounded* active set. The runtime maintains the index from the first
   * instance, so an empty index simply means no instances.
   */
  async statusCounts(): Promise<DurableStatusCounts> {
    const [completed, failed, cancelled] = await this.terminalCounts()
    const active = await this.activeSummaries()

    const counts: DurableStatusCounts = {
      ...EMPTY_COUNTS,
      completed,
      failed,
      cancelled,
      total: active.length + completed + failed + cancelled,
    }
    for (const s of active) {
      // The active set is non-terminal, so this only bumps
      // running/sleeping/retrying/waiting (terminal counts came from ZCARD).
      counts[s.derivedStatus] += 1
      if (s.stuck) counts.stuck += 1
    }
    return counts
  }

  /** Summarize already-loaded instances, fetching steps only for those whose
   *  derived status needs them. Shared by the count and list paths. */
  private async summarizeInstances(
    instances: StoredInstanceState[],
  ): Promise<DurableInstanceSummary[]> {
    const now = Date.now()
    const stepHungryIds = instances.filter((i) => STEP_HUNGRY.has(i.status)).map((i) => i.id)
    const stepsById = await this.loadStepsFor(stepHungryIds)
    // A `running` instance whose advisory lock is still held is a worker actively
    // making progress on a long step — not stuck — even though the runtime only
    // bumps `updatedAt` on transitions (so a long step looks "stale" by time alone).
    // Check lock liveness to suppress that running_stale false-positive.
    const runningIds = instances.filter((i) => i.status === "running").map((i) => i.id)
    const locked = await this.lockedInstanceIds(runningIds)
    return instances.map((instance) => {
      const summary = this.summarize(instance, stepsById.get(instance.id) ?? [], now)
      if (summary.stuck === "running_stale" && locked.has(instance.id)) {
        return { ...summary, stuck: null }
      }
      return summary
    })
  }

  /** Of the given instance ids, which currently hold a live advisory lock? */
  private async lockedInstanceIds(ids: string[]): Promise<Set<string>> {
    const held = new Set<string>()
    if (ids.length === 0) return held
    const pipe = this.redis.pipeline()
    for (const id of ids) pipe.exists(lockKey(this.prefix, id))
    const res = await pipe.exec()
    res?.forEach(([, exists], index) => {
      if (exists === 1) held.add(ids[index]!)
    })
    return held
  }

  /** Exact terminal counts, READ-ONLY: count only ids whose expiry score is still
   *  in the future (`ZCOUNT '(now' '+inf'`). Retention-expired entries are excluded
   *  by score even if not yet physically pruned, so the count is exact WITHOUT the
   *  overview endpoint having to write (the runtime prunes on each terminal
   *  transition). */
  private async terminalCounts(): Promise<[completed: number, failed: number, cancelled: number]> {
    const now = Date.now()
    const pipe = this.redis.pipeline()
    for (const status of TERMINAL_STATUSES) {
      pipe.zcount(terminalIndexKey(this.prefix, status), `(${now}`, "+inf")
    }
    const res = await pipe.exec()
    const card = (i: number) => Number(res?.[i]?.[1] ?? 0)
    return [card(0), card(1), card(2)]
  }

  /** Hydrate + summarize the bounded active (non-terminal) set — no scan. Shared
   *  by the overview counts and the health inspector's stuck/orphan detection
   *  (every "stuck" kind is a non-terminal condition). */
  async activeSummaries(): Promise<DurableInstanceSummary[]> {
    const instances = await this.loadInstancesByIds(
      await this.redis.smembers(activeIndexKey(this.prefix)),
    )
    // Defensive: an instance that has since gone terminal but lingers in the
    // active set (a transition/backfill race) is not "active". Drop it from the
    // tally and self-heal the index.
    const live: StoredInstanceState[] = []
    const stale: string[] = []
    for (const i of instances) {
      if (i.status === "running" || i.status === "yielded") live.push(i)
      else stale.push(i.id)
    }
    if (stale.length > 0) {
      void this.redis.srem(activeIndexKey(this.prefix), ...stale).catch(() => {})
    }
    return this.summarizeInstances(live)
  }

  /** Pipelined HGETALL of specific instance ids (no scan). */
  private async loadInstancesByIds(ids: string[]): Promise<StoredInstanceState[]> {
    if (ids.length === 0) return []
    const pipeline = this.redis.pipeline()
    for (const id of ids) pipeline.hgetall(instanceKey(this.prefix, id))
    const results = await pipeline.exec()
    const out: StoredInstanceState[] = []
    results?.forEach(([err, hash], index) => {
      if (err) return
      const parsed = parseInstanceHash(hash as Record<string, string>)
      if (parsed) out.push(parsed.id ? parsed : { ...parsed, id: ids[index]! })
    })
    return out
  }

  async getInstance(instanceId: string): Promise<DurableInstanceDetail | null> {
    const instance = await this.loadInstance(instanceId)
    if (!instance) return null
    const steps = await this.loadSteps(instanceId)
    return toInstanceDetail(instance, steps, Date.now(), this.thresholdMs)
  }

  async getSteps(instanceId: string): Promise<DurableStep[]> {
    const now = Date.now()
    const steps = await this.loadSteps(instanceId)
    return steps.map((s) => toStep(s, now))
  }

  async getLogs(instanceId: string): Promise<DurableLogEntry[]> {
    const raw = await this.redis.lrange(logsKey(this.prefix, instanceId), 0, -1)
    return raw
      .map(parseLog)
      .filter((l): l is NonNullable<typeof l> => l !== null)
      .map((l) => ({ message: l.message, meta: l.meta, timestamp: l.timestamp }))
  }

  async getEvents(instanceId: string): Promise<DurableEvent[]> {
    const instance = await this.loadInstance(instanceId)
    if (!instance) return []
    const [steps, logs] = await Promise.all([
      this.loadSteps(instanceId),
      this.redis
        .lrange(logsKey(this.prefix, instanceId), 0, -1)
        .then((raw) => raw.map(parseLog).filter((l): l is NonNullable<typeof l> => l !== null)),
    ])
    return synthesizeEvents(instance, steps, logs)
  }

  /** Of the given instance ids, which actually exist? (pipelined EXISTS). */
  async existing(instanceIds: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    if (instanceIds.length === 0) return found
    const pipeline = this.redis.pipeline()
    for (const id of instanceIds) pipeline.exists(instanceKey(this.prefix, id))
    const results = await pipeline.exec()
    results?.forEach(([, exists], index) => {
      if (exists === 1) found.add(instanceIds[index]!)
    })
    return found
  }

  // -- Actions -------------------------------------------------------------

  async resumeNow(instanceId: string): Promise<void> {
    const instance = await this.requireInstance(instanceId)
    if (instance.status === "completed" || instance.status === "cancelled") {
      throw badRequest(`Cannot resume a ${instance.status} instance`)
    }
    if (instance.status === "failed") {
      throw badRequest("Use retry to re-run a failed instance")
    }
    await this.enqueueResume(instance, 0)
    await this.appendCockpitLog(instanceId, "Resume requested from cockpit", { action: "resume" })
  }

  async retry(instanceId: string): Promise<void> {
    const instance = await this.requireInstance(instanceId)
    if (instance.status !== "failed") {
      throw badRequest("Retry only applies to failed instances")
    }
    // Reactivate: clear the error, restore `running`, move it back into the active
    // set (out of every done bucket) and drop the retention TTL — a re-running
    // instance must not expire. The failed step is left as-is: a replay re-runs any
    // non-completed step, so it executes again naturally.
    await this.reactivate(instanceId)
    await this.enqueueResume(instance, 0)
    await this.appendCockpitLog(instanceId, "Retry requested from cockpit", { action: "retry" })
  }

  async cancel(instanceId: string): Promise<void> {
    const instance = await this.requireInstance(instanceId)
    if (instance.status === "completed" || instance.status === "cancelled") {
      throw badRequest(`Cannot cancel a ${instance.status} instance`)
    }
    // Best-effort removal of the pending tick — correctness does not depend on it,
    // since any tick that still fires sees the cancelled status and stops.
    await this.tryRemoveJob(instance.queueName, instance.originalJobId)
    if (instance.resumeSeq > 0) {
      await this.tryRemoveJob(
        instance.queueName,
        resumeJobId(instance.originalJobId, instance.resumeSeq),
      )
    }
    await this.appendCockpitLog(instanceId, "Cancelled from cockpit", { action: "cancel" })
    // A real terminal transition, mirroring the runtime. The cockpit can't see the
    // runtime's configured retention, so it bounds the cancelled state with the
    // default (see markTerminal — one source of truth for the index/score/TTL).
    await this.markTerminal(instanceId, "cancelled", DEFAULT_RETENTION_MS.cancelled)
  }

  async deleteState(instanceId: string): Promise<void> {
    const instance = await this.requireInstance(instanceId)
    // Remove any pending tick FIRST. Deleting the state alone would let a still
    // pending resume tick fire and have the runtime re-create ("resurrect") the
    // instance from scratch — re-running the whole workflow and re-adding it to the
    // index. Mirrors cancel's tick removal; only the durable plumbing job is
    // touched, never business data.
    await this.tryRemoveJob(instance.queueName, instance.originalJobId)
    if (instance.resumeSeq > 0) {
      await this.tryRemoveJob(
        instance.queueName,
        resumeJobId(instance.originalJobId, instance.resumeSeq),
      )
    }
    await this.purge(instanceId)
  }

  // -- Index maintenance (one source of truth for the transition convention) ----
  //
  // The cockpit mirrors the runtime's atomic transition here with MULTI/EXEC, so a
  // concurrent worker tick can't interleave between the status flip and the index
  // move (a non-transactional pipeline could leave e.g. a live `running` instance
  // counted as cancelled with an expiry TTL). One helper per transition keeps the
  // bucket/score/key/TTL convention in a single place, not hand-rolled per call.

  private instanceKeys(id: string): [instance: string, steps: string, logs: string] {
    return [instanceKey(this.prefix, id), stepsKey(this.prefix, id), logsKey(this.prefix, id)]
  }

  /** Move an instance into a terminal bucket, scored by expiry, with a TTL (cancel). */
  private async markTerminal(
    instanceId: string,
    status: TerminalStatus,
    ttl: number,
  ): Promise<void> {
    const now = Date.now()
    const [inst, steps, logs] = this.instanceKeys(instanceId)
    await this.redis
      .multi()
      .hset(inst, "status", status, "updatedAt", String(now))
      .srem(activeIndexKey(this.prefix), instanceId)
      .zadd(terminalIndexKey(this.prefix, status), now + ttl, instanceId)
      .pexpire(inst, ttl)
      .pexpire(steps, ttl)
      .pexpire(logs, ttl)
      .exec()
  }

  /** Lift an instance back into the active set, clearing every terminal entry + TTL (retry). */
  private async reactivate(instanceId: string): Promise<void> {
    const [inst, steps, logs] = this.instanceKeys(instanceId)
    const m = this.redis
      .multi()
      .hdel(inst, "error", "failedAt")
      .hset(inst, "status", "running", "updatedAt", String(Date.now()))
      .sadd(activeIndexKey(this.prefix), instanceId)
    for (const st of TERMINAL_STATUSES) m.zrem(terminalIndexKey(this.prefix, st), instanceId)
    await m.persist(inst).persist(steps).persist(logs).exec()
  }

  /** Delete an instance's data keys and remove it from every index set (delete). */
  private async purge(instanceId: string): Promise<void> {
    const [inst, steps, logs] = this.instanceKeys(instanceId)
    const m = this.redis
      .multi()
      .del(inst, steps, logs, lockKey(this.prefix, instanceId))
      .srem(activeIndexKey(this.prefix), instanceId)
    for (const st of TERMINAL_STATUSES) m.zrem(terminalIndexKey(this.prefix, st), instanceId)
    await m.exec()
  }

  // -- Internals -----------------------------------------------------------

  private summarize(
    instance: StoredInstanceState,
    steps: StoredStepState[],
    now: number,
  ): DurableInstanceSummary {
    // `toInstanceDetail` reuses the same summary projection; build the detail
    // and strip the heavy fields to avoid duplicating the derivation logic.
    const detail = toInstanceDetail(instance, steps, now, this.thresholdMs)
    const { input: _input, output: _output, error: _error, steps: _steps, ...summary } = detail
    return summary
  }

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

  private async enqueueResume(instance: StoredInstanceState, delayMs: number): Promise<void> {
    const seq = await this.allocateResumeSeq(instance.id)
    const envelope = {
      [DURABLE_META_KEY]: {
        instanceId: instance.id,
        originalJobId: instance.originalJobId,
        resumeSeq: seq,
      },
      payload: instance.input,
    }
    await this.getQueue(instance.queueName).add(instance.jobName, envelope, {
      delay: delayMs,
      jobId: resumeJobId(instance.originalJobId, seq),
      attempts: 3,
      removeOnComplete: true,
    })
  }

  /** Atomically allocate the next resume sequence (mirrors the runtime). */
  private async allocateResumeSeq(instanceId: string): Promise<number> {
    const key = instanceKey(this.prefix, instanceId)
    const [seq] = await this.redis
      .multi()
      .hincrby(key, "resumeSeq", 1)
      .hset(key, "updatedAt", String(Date.now()))
      .exec()
      .then((res) => [res?.[0]?.[1] as number])
    return typeof seq === "number" ? seq : Number(seq ?? 0)
  }

  private async appendCockpitLog(
    instanceId: string,
    message: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const key = logsKey(this.prefix, instanceId)
    const entry = JSON.stringify({
      message,
      timestamp: Date.now(),
      meta: { source: "cockpit", ...meta },
    })
    await this.redis.multi().rpush(key, entry).ltrim(key, -MAX_COCKPIT_LOGS, -1).exec()
  }

  private async tryRemoveJob(queueName: string, jobId: string): Promise<void> {
    try {
      const job = await this.getQueue(queueName).getJob(jobId)
      if (job) await job.remove().catch(() => undefined)
    } catch {
      // Best effort.
    }
  }

  private async loadInstance(instanceId: string): Promise<StoredInstanceState | null> {
    const hash = await this.redis.hgetall(instanceKey(this.prefix, instanceId))
    return parseInstanceHash(hash)
  }

  private async requireInstance(instanceId: string): Promise<StoredInstanceState> {
    const instance = await this.loadInstance(instanceId)
    if (!instance) throw notFound(`Durable instance "${instanceId}" not found`)
    return instance
  }

  private async loadSteps(instanceId: string): Promise<StoredStepState[]> {
    const hash = await this.redis.hgetall(stepsKey(this.prefix, instanceId))
    return Object.values(hash)
      .map(parseStep)
      .filter((s): s is StoredStepState => s !== null)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  private async loadStepsFor(instanceIds: string[]): Promise<Map<string, StoredStepState[]>> {
    const byId = new Map<string, StoredStepState[]>()
    if (instanceIds.length === 0) return byId
    const pipeline = this.redis.pipeline()
    for (const id of instanceIds) pipeline.hgetall(stepsKey(this.prefix, id))
    const results = await pipeline.exec()
    results?.forEach(([err, hash], index) => {
      if (err) return
      const steps = Object.values(hash as Record<string, string>)
        .map(parseStep)
        .filter((s): s is StoredStepState => s !== null)
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      byId.set(instanceIds[index]!, steps)
    })
    return byId
  }
}
