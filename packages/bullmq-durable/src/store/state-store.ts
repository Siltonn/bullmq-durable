/**
 * The persistence contract for durable execution state.
 *
 * Two implementations ship with the library:
 *  - {@link import("./redis-store").RedisStateStore} (default, production)
 *  - {@link import("./memory-store").MemoryStateStore} (tests / single process)
 *
 * Advanced users can supply their own (e.g. backed by Postgres) by
 * implementing this interface and passing it as `stateStore`.
 */

import type { DurableLog, InstanceState, StepState } from "../types"

/** Arguments for lazily creating an instance on its first execution tick. */
export interface InitInstanceInput {
  instanceId: string
  queueName: string
  jobName: string
  /** The BullMQ job id of the first tick (becomes `originalJobId`). */
  jobId: string
  input: unknown
}

export interface StateStore {
  // -- Instance lifecycle --------------------------------------------------

  /**
   * Create the instance if it does not yet exist and return its current state.
   * Must be idempotent: calling it for an existing instance returns the stored
   * state untouched.
   */
  initInstance(input: InitInstanceInput): Promise<InstanceState>

  /** Read an instance, or `null` if it is unknown or has expired. */
  getInstance(instanceId: string): Promise<InstanceState | null>

  /** Shallow-merge a patch into an instance and return the updated state. */
  updateInstance(instanceId: string, patch: Partial<InstanceState>): Promise<InstanceState | null>

  /** Mark an instance completed and store its output. */
  completeInstance(instanceId: string, output: unknown): Promise<void>

  /** Mark an instance failed and store the serialized error. */
  failInstance(instanceId: string, error: unknown): Promise<void>

  /** Mark an instance cancelled. */
  cancelInstance(instanceId: string): Promise<void>

  /** Atomically allocate the next resume sequence number for an instance. */
  nextResumeSeq(instanceId: string): Promise<number>

  // -- Steps ---------------------------------------------------------------

  getStep(instanceId: string, stepKey: string): Promise<StepState | null>

  getSteps(instanceId: string): Promise<StepState[]>

  saveStep(instanceId: string, stepKey: string, state: StepState): Promise<void>

  updateStep(instanceId: string, stepKey: string, patch: Partial<StepState>): Promise<void>

  // -- Logs ----------------------------------------------------------------

  /** Append a log line, trimming the list to at most `maxLogs` entries. */
  appendLog(instanceId: string, log: DurableLog, maxLogs?: number): Promise<void>

  getLogs(instanceId: string): Promise<DurableLog[]>

  // -- Locking -------------------------------------------------------------

  /**
   * Try to acquire the instance lock. Returns `true` if the lock is now held by
   * `token`. Acquiring with the token already held renews it (re-entrant).
   */
  acquireLock(instanceId: string, token: string, ttlMs: number): Promise<boolean>

  /** Extend the lock TTL if still held by `token`. Returns `false` if lost. */
  renewLock(instanceId: string, token: string, ttlMs: number): Promise<boolean>

  /** Release the lock if still held by `token`. */
  releaseLock(instanceId: string, token: string): Promise<void>

  // -- Retention -----------------------------------------------------------

  /** Schedule the instance (and its steps/logs) to expire after `ttlMs`. */
  expireInstance(instanceId: string, ttlMs: number): Promise<void>

  // -- Lifecycle -----------------------------------------------------------

  /** Release any underlying resources (connections). */
  close(): Promise<void>
}
