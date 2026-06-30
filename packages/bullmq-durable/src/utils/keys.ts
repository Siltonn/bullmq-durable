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

/** `{prefix}:logs:{instanceId}` — the bounded log list. */
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
 * The BullMQ job id used for a resume tick. Encodes the resume sequence so each
 * resume is a distinct job (BullMQ ignores `add` for a duplicate job id).
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

/** ZSET score meaning "this terminal instance has no retention TTL, so it never
 *  expires and must never be pruned." Chosen far beyond any realistic epoch-ms
 *  (≈ year 2286) so `ZREMRANGEBYSCORE … -inf <now>` always skips it. */
export const INDEX_NEVER_EXPIRES = 9_999_999_999_999

/** The terminal statuses that each get their own index bucket. */
export type TerminalStatus = "completed" | "failed" | "compensation_failed" | "cancelled"

/** `{prefix}:idx:active` — SET of non-terminal (running/yielded) instance ids.
 *  Bounded by in-flight work, so hydrating it in full stays cheap. */
export function activeIndexKey(prefix: string): string {
  return `${prefix}:idx:active`
}

/** `{prefix}:idx:done:{status}` — ZSET of terminal instance ids, scored by the
 *  epoch-ms at which the instance should expire ({@link INDEX_NEVER_EXPIRES} when
 *  un-retained). Scoring by expiry lets a reader count or list only the still-live
 *  ids *by score* (`ZCOUNT '(now' '+inf'`, `ZREVRANGEBYSCORE '+inf' '(now'`) —
 *  exact and read-only, whether or not expired entries have been physically
 *  removed yet. The runtime prunes them on each terminal transition (and on
 *  `expireInstance`) via `ZREMRANGEBYSCORE … -inf <now>`. */
export function terminalIndexKey(prefix: string, status: TerminalStatus): string {
  return `${prefix}:idx:done:${status}`
}
