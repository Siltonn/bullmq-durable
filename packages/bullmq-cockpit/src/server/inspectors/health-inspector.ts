/**
 * HealthInspector — connection health plus durable "stuck" detection.
 *
 * The stuck classes split across the two data sources:
 *  - `running_stale` / `resume_missed` are derivable from durable state alone
 *    (computed in {@link DurableInspector} and surfaced on each summary).
 *  - `orphan_instance` correlates with BullMQ: a non-terminal instance is
 *    healthy iff its (single) job still exists in a live state. A missing job
 *    means it was hand-deleted under the runtime; a `failed` job under a
 *    non-terminal instance means stall settlement died mid-way.
 *  - `orphan_resume_job` is the legacy (0.1.x rolling-upgrade) check for
 *    envelope resume ticks pointing at missing instances. Removed in 0.3.0.
 *
 * Stuck detection is an on-demand endpoint, so the BullMQ scans here are bounded
 * by a cap rather than streaming the whole keyspace.
 */

import type { Queue } from "bullmq"
import type { Redis } from "ioredis"
import type { Health, StuckInstance, StuckKind, StuckReport } from "../../shared/dto"
import { DURABLE_META_KEY, isResumeEnvelope } from "bullmq-durable"
import type { BullMQInspector } from "./bullmq"
import type { DurableInspector } from "./durable-inspector"

/** How many pending jobs per queue / yielded instances we probe for orphans. */
const SCAN_CAP = 500

export interface HealthInspectorDeps {
  redis: Redis
  bullmq: BullMQInspector
  durable?: DurableInspector
  /** Live "is durable in use?" (explicit setting, or the auto probe). */
  detectDurable: () => Promise<boolean>
  /** Whether 0.1.x legacy markers are present (gates the orphan-resume scan). */
  legacyDurablePresent: () => Promise<boolean>
  stuckThresholdMs: number
  getQueue: (name: string) => Queue
}

export class HealthInspector {
  private readonly redis: Redis
  private readonly bullmq: BullMQInspector
  private readonly durable?: DurableInspector
  private readonly detectDurable: () => Promise<boolean>
  private readonly legacyDurablePresent: () => Promise<boolean>
  private readonly defaultThresholdMs: number
  private readonly getQueue: (name: string) => Queue

  constructor(deps: HealthInspectorDeps) {
    this.redis = deps.redis
    this.bullmq = deps.bullmq
    this.durable = deps.durable
    this.detectDurable = deps.detectDurable
    this.legacyDurablePresent = deps.legacyDurablePresent
    this.defaultThresholdMs = deps.stuckThresholdMs
    this.getQueue = deps.getQueue
  }

  async health(): Promise<Health> {
    const startedAt = Date.now()
    let redisOk = false
    let latencyMs: number | undefined
    let error: string | undefined
    try {
      await this.redis.ping()
      redisOk = true
      latencyMs = Date.now() - startedAt
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    let queues = 0
    try {
      queues = (await this.bullmq.queueNames()).length
    } catch {
      // leave at 0
    }

    return {
      redis: { ok: redisOk, latencyMs, error },
      durableEnabled: await this.detectDurable(),
      queues,
      generatedAt: Date.now(),
    }
  }

  async stuck(thresholdMs?: number): Promise<StuckReport> {
    const threshold = thresholdMs ?? this.defaultThresholdMs
    const found: StuckInstance[] = []

    if (this.durable && (await this.detectDurable())) {
      // Every "stuck" kind is a non-terminal condition (running_stale /
      // resume_missed / orphan_instance), so the bounded active set is sufficient
      // — no full scan.
      const summaries = await this.durable.activeSummaries()

      // running_stale / resume_missed are precomputed on each summary.
      for (const s of summaries) {
        if (s.stuck) {
          found.push({
            kind: s.stuck,
            detail:
              s.stuck === "running_stale"
                ? `Running with no update for ${describeAge(s.updatedAt)}`
                : `Resume was due ${describeAge(s.nextRunAt)} ago but has not fired`,
            instanceId: s.id,
            queueName: s.queueName,
            jobName: s.jobName,
            status: s.status,
            nextRunAt: s.nextRunAt,
            updatedAt: s.updatedAt,
          })
        }
      }

      // orphan_instance: a non-terminal instance whose (single) job is gone or
      // terminally failed. One run = one job, so job state is the health truth:
      //  - missing job → hand-deleted / bulk-cleaned under the runtime;
      //  - failed job  → stall settlement died before finishing (retry it).
      const yielded = summaries.filter((s) => s.status === "yielded")
      for (const s of yielded.slice(0, SCAN_CAP)) {
        // Carrier resolution (incl. the 0.1.x legacy fallback) lives in the
        // runtime package — one source of truth for "which job carries a run".
        const state = await this.durable.carrierState(s.queueName, s.originalJobId)
        const healthy =
          state === "delayed" ||
          state === "waiting" ||
          state === "prioritized" ||
          state === "active" ||
          state === "waiting-children"
        if (!healthy) {
          found.push({
            kind: "orphan_instance",
            detail:
              state === "missing"
                ? `Instance's job "${s.originalJobId}" no longer exists (removed outside the runtime)`
                : state === "failed"
                  ? `Instance's job failed but settlement never finished — retry it from the dashboard`
                  : `Instance's job "${s.originalJobId}" is in unexpected state "${state}"`,
            instanceId: s.id,
            queueName: s.queueName,
            jobName: s.jobName,
            status: s.status,
            nextRunAt: s.nextRunAt,
            updatedAt: s.updatedAt,
          })
        }
      }

      // orphan_resume_job (LEGACY, 0.1.x rolling-upgrade window): a pending
      // envelope resume job whose instance no longer EXISTS. Removed in 0.3.0.
      // This is the ONE scan that hydrates real jobs per queue — gated behind
      // the legacy-marker probe so it costs nothing once (or if) no 0.1.x
      // data exists: the display layer must never tax a clean deployment.
      if (await this.legacyDurablePresent()) {
        const queueNames = await this.bullmq.queueNames().catch(() => [])
        for (const name of queueNames) {
          found.push(...(await this.findOrphanResumeJobs(name)))
        }
      }
    }

    // Dedup by instance: an overdue instance whose tick is also gone is both
    // resume_missed AND orphan_instance — count it once (keeping the most specific,
    // root-cause kind) so stuck.length and the alert metric don't double-count it.
    const stuck = dedupeStuck(found)
    const countsByKind = tallyKinds(stuck)
    return { thresholdMs: threshold, stuck, countsByKind }
  }

  private async findOrphanResumeJobs(queueName: string): Promise<StuckInstance[]> {
    if (!this.durable) return []
    const queue = this.getQueue(queueName)
    const jobs = await queue
      .getJobs(["delayed", "waiting", "active", "prioritized"] as never, 0, SCAN_CAP - 1, true)
      .catch(() => [])

    // Collect the instance ids the pending resume jobs point at, then ask the
    // store which actually exist (pipelined EXISTS) — a targeted check, never a
    // full scan.
    const candidates: Array<{ instanceId: string; jobName: string; jobId: string }> = []
    for (const job of jobs) {
      if (!job || !isResumeEnvelope(job.data)) continue
      candidates.push({
        instanceId: job.data[DURABLE_META_KEY].instanceId,
        jobName: job.name,
        jobId: String(job.id),
      })
    }
    if (candidates.length === 0) return []

    const present = await this.durable.existing(candidates.map((c) => c.instanceId))
    return candidates
      .filter((c) => !present.has(c.instanceId))
      .map((c) => ({
        kind: "orphan_resume_job",
        detail: `Resume job points at missing instance "${c.instanceId}"`,
        instanceId: c.instanceId,
        queueName,
        jobName: c.jobName,
        jobId: c.jobId,
      }))
  }
}

function describeAge(timestamp?: number): string {
  if (timestamp === undefined) return "an unknown time"
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/** Collapse multiple stuck reports for the same instance into the single most
 *  specific one (orphan_instance > resume_missed > running_stale > orphan_resume_job),
 *  so an overdue-and-orphaned instance isn't counted twice in stuck.length / alerts. */
function dedupeStuck(items: StuckInstance[]): StuckInstance[] {
  const priority: Record<StuckKind, number> = {
    orphan_instance: 3,
    resume_missed: 2,
    running_stale: 1,
    orphan_resume_job: 0,
  }
  const byId = new Map<string, StuckInstance>()
  const unkeyed: StuckInstance[] = []
  for (const item of items) {
    if (!item.instanceId) {
      unkeyed.push(item) // no id to dedup on — keep as-is
      continue
    }
    const current = byId.get(item.instanceId)
    if (!current || priority[item.kind] > priority[current.kind]) byId.set(item.instanceId, item)
  }
  return [...byId.values(), ...unkeyed]
}

function tallyKinds(stuck: StuckInstance[]): Record<StuckKind, number> {
  const counts: Record<StuckKind, number> = {
    running_stale: 0,
    resume_missed: 0,
    orphan_resume_job: 0,
    orphan_instance: 0,
  }
  for (const item of stuck) counts[item.kind] += 1
  return counts
}
