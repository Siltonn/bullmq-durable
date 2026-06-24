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

/** `{prefix}:instance:{instanceId}` — the instance hash. */
export function instanceKey(prefix: string, instanceId: string): string {
  return `${prefix}:instance:${instanceId}`
}

/** `{prefix}:instance:{instanceId}:steps` — the per-step hash. */
export function stepsKey(prefix: string, instanceId: string): string {
  return `${prefix}:instance:${instanceId}:steps`
}

/** `{prefix}:instance:{instanceId}:logs` — the bounded log list. */
export function logsKey(prefix: string, instanceId: string): string {
  return `${prefix}:instance:${instanceId}:logs`
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
