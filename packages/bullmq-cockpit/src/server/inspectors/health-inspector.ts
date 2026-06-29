/**
 * HealthInspector — connection health plus durable "stuck" detection.
 *
 * The four stuck classes (see RFC §20) split across the two data sources:
 *  - `running_stale` / `resume_missed` are derivable from durable state alone
 *    (computed in {@link DurableInspector} and surfaced on each summary).
 *  - `orphan_resume_job` needs a peek at BullMQ's pending jobs.
 *  - `orphan_instance` needs to confirm a yielded instance still has a tick.
 *
 * Stuck detection is an on-demand endpoint, so the BullMQ scans here are bounded
 * by a cap rather than streaming the whole keyspace.
 */

import type { Queue } from "bullmq"
import type { Redis } from "ioredis"
import type { Health, StuckInstance, StuckKind, StuckReport } from "../../shared/dto"
import { DURABLE_META_KEY, isResumeEnvelope, resumeJobId } from "../durable/protocol"
import type { BullMQInspector } from "./bullmq"
import type { DurableInspector } from "./durable-inspector"

/** How many pending jobs per queue / yielded instances we probe for orphans. */
const SCAN_CAP = 500

export interface HealthInspectorDeps {
  redis: Redis
  bullmq: BullMQInspector
  durable?: DurableInspector
  durableEnabled: boolean
  stuckThresholdMs: number
  getQueue: (name: string) => Queue
}

export class HealthInspector {
  private readonly redis: Redis
  private readonly bullmq: BullMQInspector
  private readonly durable?: DurableInspector
  private readonly durableEnabled: boolean
  private readonly defaultThresholdMs: number
  private readonly getQueue: (name: string) => Queue

  constructor(deps: HealthInspectorDeps) {
    this.redis = deps.redis
    this.bullmq = deps.bullmq
    this.durable = deps.durable
    this.durableEnabled = deps.durableEnabled
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
      durableEnabled: this.durableEnabled,
      queues,
      generatedAt: Date.now(),
    }
  }

  async stuck(thresholdMs?: number): Promise<StuckReport> {
    const threshold = thresholdMs ?? this.defaultThresholdMs
    const found: StuckInstance[] = []

    if (this.durable) {
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

      // orphan_instance: a yielded instance whose latest resume tick is gone.
      const yielded = summaries.filter((s) => s.status === "yielded" && s.resumeSeq > 0)
      for (const s of yielded.slice(0, SCAN_CAP)) {
        const expectedId = resumeJobId(s.originalJobId, s.resumeSeq)
        const job = await this.getQueue(s.queueName)
          .getJob(expectedId)
          .catch(() => undefined)
        if (!job) {
          found.push({
            kind: "orphan_instance",
            detail: `Yielded instance has no pending resume job (${expectedId})`,
            instanceId: s.id,
            queueName: s.queueName,
            jobName: s.jobName,
            status: s.status,
            nextRunAt: s.nextRunAt,
            updatedAt: s.updatedAt,
          })
        }
      }

      // orphan_resume_job: a pending resume job whose instance no longer EXISTS (a
      // tick pointing at a *terminal* instance is not flagged — the runtime no-ops
      // it and removeOnComplete clears it, so it self-heals rather than sticks).
      const queueNames = await this.bullmq.queueNames().catch(() => [])
      for (const name of queueNames) {
        found.push(...(await this.findOrphanResumeJobs(name)))
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
