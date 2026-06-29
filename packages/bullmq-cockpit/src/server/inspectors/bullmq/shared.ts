/**
 * Cross-cutting helpers, constants, and the shared deps type for the BullMQ
 * inspectors. Only genuinely cross-domain pieces live here; domain-specific
 * helpers live with their inspector.
 */

import type { Job, JobType, Queue } from "bullmq"
import type { Redis } from "ioredis"
import type { JobCounts } from "../../../shared/dto"
import { scanKeys } from "../../infra/redis"
import type { DurableInspector } from "../durable-inspector"

export interface BullMQInspectorDeps {
  redis: Redis
  bullPrefix: string
  /** Explicit queue allow-list, or `null` to auto-discover from Redis. */
  queues: string[] | null
  getQueue: (name: string) => Queue
  durable?: DurableInspector
}

/**
 * Every job-count bucket we ask BullMQ about. `satisfies readonly JobType[]`
 * anchors the list to BullMQ's own union, so a future rename/drop fails to
 * compile; `as const` keeps the literal tuple for indexing {@link JobCounts}.
 */
export const ALL_JOB_TYPES = [
  "active",
  "waiting",
  "waiting-children",
  "prioritized",
  "delayed",
  "paused",
  "completed",
  "failed",
] as const satisfies readonly JobType[]

export const EMPTY_COUNTS: JobCounts = {
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0,
  prioritized: 0,
  "waiting-children": 0,
}

export async function jobCounts(queue: Queue): Promise<JobCounts> {
  const counts = { ...EMPTY_COUNTS }
  try {
    const raw = (await queue.getJobCounts(...ALL_JOB_TYPES)) as Record<string, number>
    for (const type of ALL_JOB_TYPES) counts[type] = raw[type] ?? 0
  } catch {
    // Unreachable in practice — fall back to the zeroed counts.
  }
  return counts
}

/** Live worker count for a queue (BullMQ's CLIENT-LIST count, in one call). */
export function workerCount(queue: Queue): Promise<number> {
  return queue.getWorkersCount().catch(() => 0)
}

export function onlyJobs(jobs: (Job | undefined)[]): Job[] {
  return jobs.filter((j): j is Job => Boolean(j))
}

/** Resolve the queue names this cockpit exposes (allow-list or auto-discovered). */
export async function resolveQueueNames(deps: BullMQInspectorDeps): Promise<string[]> {
  if (deps.queues) return [...deps.queues]
  return discoverQueues(deps.redis, deps.bullPrefix)
}

/** Discover queue names by scanning BullMQ's per-queue `:meta` keys. */
export async function discoverQueues(redis: Redis, bullPrefix: string): Promise<string[]> {
  const keys = await scanKeys(redis, `${bullPrefix}:*:meta`)
  const suffix = ":meta"
  const names = new Set<string>()
  for (const key of keys) {
    if (!key.startsWith(`${bullPrefix}:`) || !key.endsWith(suffix)) continue
    const name = key.slice(bullPrefix.length + 1, key.length - suffix.length)
    // Ignore BullMQ's internal hash-tag style keys (they contain `{` / `}`).
    if (name && !name.includes("{") && !name.includes("}")) names.add(name)
  }
  return [...names].sort()
}

/** Parse a BullMQ job key `{prefix}:{queueName}:{id}` into its parts. */
export function parseJobKey(
  key: string,
  bullPrefix: string,
): { queueName: string; id: string } | null {
  const lastColon = key.lastIndexOf(":")
  if (lastColon < 0) return null
  const id = key.slice(lastColon + 1)
  const withoutId = key.slice(0, lastColon)
  // Strip the cockpit's known bull prefix if present, else fall back to the
  // segment immediately before the id.
  const queueName = withoutId.startsWith(`${bullPrefix}:`)
    ? withoutId.slice(bullPrefix.length + 1)
    : withoutId.slice(withoutId.lastIndexOf(":") + 1)
  return { queueName, id }
}
