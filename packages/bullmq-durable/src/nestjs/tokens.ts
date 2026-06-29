/**
 * DI tokens and metadata keys for the NestJS integration.
 */

/** Injection token holding the root {@link DurableBullRootOptions}. */
export const DURABLE_BULL_OPTIONS = Symbol("DURABLE_BULL_OPTIONS")

/** Injection token holding the shared {@link StateStore} reused by every queue/worker. */
export const DURABLE_STATE_STORE = Symbol("DURABLE_STATE_STORE")

/** Optional injection token overriding how workers are constructed (tests). */
export const DURABLE_WORKER_FACTORY = Symbol("DURABLE_WORKER_FACTORY")

/** Metadata key set by `@DurableProcessor()` on a class. */
export const DURABLE_PROCESSOR_METADATA = Symbol("DURABLE_PROCESSOR")

/** Metadata key set by `@DurableProcess()` on a method. */
export const DURABLE_PROCESS_METADATA = Symbol("DURABLE_PROCESS")

/** Provider token for an injectable {@link DurableQueue}. */
export function getDurableQueueToken(name: string): string {
  return `BULLMQ_DURABLE_QUEUE:${name}`
}

/** Provider token holding the per-queue registration options. */
export function getDurableQueueOptionsToken(name: string): string {
  return `BULLMQ_DURABLE_QUEUE_OPTS:${name}`
}
