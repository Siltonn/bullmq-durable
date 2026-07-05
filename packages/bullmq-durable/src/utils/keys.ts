/**
 * Centralised key/id construction.
 *
 * Keeping every key format in one place makes the Redis layout easy to audit
 * and guarantees the worker, queue, and store all agree on naming.
 */

/** The default Redis key prefix for all durable state. */
export const DEFAULT_DURABLE_PREFIX = "bullmq-durable"

/**
 * Build the stable durable instance id for a job.
 *
 * A durable instance is the real unit of execution. A single instance may be
 * driven by many BullMQ jobs over its lifetime (the original job plus resume
 * ticks), so the id is derived from the *original* job id, not the current one.
 */
export function createInstanceId(queueName: string, jobId: string | number): string {
  return `${queueName}:${jobId}`
}

// The kind of state is encoded as a fixed segment *before* the instance id, so
// the instance id is always the trailing part of the key. This guarantees the
// instance hash of one instance can never collide with the steps/logs key of
// another (which the old `…:instance:{id}:steps` suffix layout allowed when an
// instance id ended in `:steps`).

/** `{prefix}:instance:{instanceId}` — the instance hash. */
export function instanceKey(prefix: string, instanceId: string): string {
  return `${prefix}:instance:${instanceId}`
}

/** `{prefix}:steps:{instanceId}` — the per-step hash. */
export function stepsKey(prefix: string, instanceId: string): string {
  return `${prefix}:steps:${instanceId}`
}

/**
 * `{prefix}:logs:{instanceId}` — the 0.1.x bounded log list.
 *
 * @deprecated 0.2.0 stores logs in the BullMQ job log (`job.log()`). The key is
 * kept only so the reaper can delete leftover 0.1.x lists; removed in 0.3.0.
 */
export function logsKey(prefix: string, instanceId: string): string {
  return `${prefix}:logs:${instanceId}`
}

/** `{prefix}:lock:{instanceId}` — the instance advisory lock. */
export function lockKey(prefix: string, instanceId: string): string {
  return `${prefix}:lock:${instanceId}`
}

/**
 * A deterministic id for a single step within an instance, suitable for use as
 * a business-level idempotency key (e.g. a credit-ledger row id). Surfaced to
 * users via `ctx.stepId(key)`.
 */
export function stepIdOf(instanceId: string, stepKey: string): string {
  return `${instanceId}:${stepKey}`
}

/**
 * The BullMQ job id used by 0.1.x for a resume tick.
 *
 * @deprecated 0.2.0 has no resume jobs (a run rides one job via
 * `moveToDelayed`). Kept only so `cancel()` can find an in-flight legacy resume
 * job during a rolling upgrade; removed in 0.3.0.
 */
export function resumeJobId(originalJobId: string, resumeSeq: number): string {
  return `${originalJobId}:resume:${resumeSeq}`
}

// ---------------------------------------------------------------------------
// Status index — the bundled RedisStateStore's on-disk optimization
// ---------------------------------------------------------------------------
//
// To let a read-only observer (the bullmq-cockpit dashboard) answer "how many
// instances are in each status?" and "which instances are in flight?" WITHOUT a
// full keyspace `SCAN`, the RedisStateStore maintains a small secondary index,
// kept in lock-step with every status transition (see redis-store.ts).
//
// It is **purely additive**: it never alters the instance/steps/logs/lock layout
// above, and it is **not** part of the StateStore contract — a custom store
// simply won't maintain it (so the dashboard, which reads the index directly,
// only sees instances written through the bundled Redis store). Treat it as an
// optimization, never as the source of truth for an individual instance.

/**
 * @deprecated 0.1.x ZSET sentinel score meaning "never expires". 0.2.0 scores
 * done-bucket entries by their terminal timestamp instead; readers must simply
 * tolerate legacy entries carrying expiry/sentinel scores until they are
 * reaped. Removed in 0.3.0.
 */
export const INDEX_NEVER_EXPIRES = 9_999_999_999_999

/** The terminal statuses that each get their own index bucket. */
export type TerminalStatus = "completed" | "failed" | "compensation_failed" | "cancelled"

/** Every terminal status, in the fixed done-bucket order. Single source of truth. */
export const TERMINAL_STATUSES: readonly TerminalStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "compensation_failed",
]

/** Whether an instance status is terminal. */
export function isTerminalStatus(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** `{prefix}:queues` — SET registry of queue names that ever created durable
 *  state, so cross-queue admin tooling can enumerate without scanning. */
export function queuesRegistryKey(prefix: string): string {
  return `${prefix}:queues`
}

/** `{prefix}:idx:{queue}:active` — SET of a queue's non-terminal instance ids.
 *  Bounded by that queue's in-flight work, so hydrating it in full stays cheap
 *  (the reconciler and dashboard both rely on that). PER QUEUE since 0.2.0 —
 *  a busy neighbour queue can no longer bloat another queue's scans. */
export function activeIndexKey(prefix: string, queueName: string): string {
  return `${prefix}:idx:${queueName}:active`
}

/** `{prefix}:idx:{queue}:done:{status}` — ZSET of a queue's terminal instance
 *  ids, scored by the epoch-ms of the terminal transition. Time-ordered, so
 *  readers list recent runs with `ZREVRANGE` and the reaper walks the OLDEST
 *  entries first (`ZRANGE 0 K`) when checking whether their BullMQ job still
 *  exists. State lives exactly as long as its job — no TTL/expiry in the score.
 *  Sizing: each bucket scales with ONE queue's `removeOnComplete/removeOnFail`
 *  retention — the same order as BullMQ's own per-queue completed/failed zsets. */
export function terminalIndexKey(
  prefix: string,
  queueName: string,
  status: TerminalStatus,
): string {
  return `${prefix}:idx:${queueName}:done:${status}`
}

/** @deprecated Pre-per-queue global (cross-queue) active set — read + reaped
 *  during one transition window, never written. Removed in 0.3.0. */
export function legacyActiveIndexKey(prefix: string): string {
  return `${prefix}:idx:active`
}

/** @deprecated See {@link legacyActiveIndexKey}. */
export function legacyTerminalIndexKey(prefix: string, status: TerminalStatus): string {
  return `${prefix}:idx:done:${status}`
}
