/**
 * The persistence contract for durable execution state.
 *
 * Two implementations ship with the library:
 *  - {@link import("./redis-store").RedisStateStore} (default, production)
 *  - {@link import("./memory-store").MemoryStateStore} (tests / single process)
 *
 * Advanced users can supply their own (e.g. backed by Postgres) by
 * implementing this interface and passing it as `stateStore`.
 *
 * Lifetime model (0.2.0): state carries NO retention TTL of its own — a run's
 * state lives exactly as long as its BullMQ job. The worker/queue layer reaps
 * state whose job has disappeared, via {@link StateStore.listOldestTerminal} /
 * {@link StateStore.listActive} / {@link StateStore.removeInstances} (the store
 * itself stays BullMQ-agnostic).
 */

import type { DurableLogEntry, InstanceState, StepPhase, StepState, StepType } from "../types"
import type { TerminalStatus } from "../utils/keys"

/** Arguments for lazily creating an instance on its first execution tick. */
export interface InitInstanceInput {
  instanceId: string
  queueName: string
  jobName: string
  /** The BullMQ job id of the run's job (becomes `originalJobId`). */
  jobId: string
  input: unknown
}

/** Creation fields for {@link StateStore.beginStep}. */
export interface BeginStepInit {
  /** Logical (un-namespaced) step key. */
  key: string
  type: StepType
  phase: StepPhase
  /** Wall-clock start of this attempt (epoch ms). */
  now: number
  /** For sleeps: the wake-up time, persisted at creation. */
  nextRunAt?: number
}

/** Outcome of {@link StateStore.beginStep}. */
export type BeginStepResult =
  /** The instance hash is gone (reclaimed / never initialised). */
  | { kind: "missing" }
  /** The instance was cancelled — the caller must stop. */
  | { kind: "cancelled" }
  /** The step already has persisted state (replay / retry / crash recovery). */
  | { kind: "existing"; step: StepState }
  /** A fresh step record was created with `status: "running"` and this seq. */
  | { kind: "created"; seq: number }

export interface StateStore {
  // -- Instance lifecycle --------------------------------------------------

  /**
   * Begin an execution tick: create the instance if it does not exist (fresh
   * instances start `running` with `runCount: 1`); otherwise, when the stored
   * instance is non-terminal, atomically increment `runCount` and flip the
   * status to `running` (`compensating` is preserved). Terminal instances are
   * returned untouched. Always returns the post-transition state.
   */
  initInstance(input: InitInstanceInput): Promise<InstanceState>

  /** Read an instance, or `null` if it is unknown. */
  getInstance(instanceId: string): Promise<InstanceState | null>

  /** Bulk read (order-preserving; `null` for unknown ids). One round-trip on Redis. */
  getInstances(instanceIds: string[]): Promise<Array<InstanceState | null>>

  /** Shallow-merge a patch into an instance and return the updated state. */
  updateInstance(instanceId: string, patch: Partial<InstanceState>): Promise<InstanceState | null>

  /**
   * Mark an instance completed and store its output. When `lockToken` is given
   * the transition is fenced: it only applies while the instance lock is free
   * or held by that token (a zombie worker whose lock was taken over cannot
   * flip state). Returns `false` when fenced out or the instance is missing.
   */
  completeInstance(instanceId: string, output: unknown, lockToken?: string): Promise<boolean>

  /** Mark an instance failed (see {@link completeInstance} re fencing). */
  failInstance(instanceId: string, error: unknown, lockToken?: string): Promise<boolean>

  /**
   * Mark an instance `compensation_failed` — failed *and* one or more
   * compensations could not be completed (see {@link completeInstance} re
   * fencing). A distinct terminal state so it can be surfaced separately.
   */
  compensationFailedInstance(
    instanceId: string,
    error: unknown,
    lockToken?: string,
  ): Promise<boolean>

  /** Mark an instance cancelled (see {@link completeInstance} re fencing). */
  cancelInstance(instanceId: string, lockToken?: string): Promise<boolean>

  // -- Steps ---------------------------------------------------------------

  /**
   * One-round-trip step entry: check the instance (missing/cancelled), read
   * existing step state, and — when the step is new — allocate its `seq` and
   * persist the initial `running` record, all atomically.
   */
  beginStep(instanceId: string, stepKey: string, init: BeginStepInit): Promise<BeginStepResult>

  getStep(instanceId: string, stepKey: string): Promise<StepState | null>

  getSteps(instanceId: string): Promise<StepState[]>

  saveStep(instanceId: string, stepKey: string, state: StepState): Promise<void>

  updateStep(instanceId: string, stepKey: string, patch: Partial<StepState>): Promise<void>

  /** Delete specific step records (admin retry paths reset failed steps). */
  removeSteps(instanceId: string, stepKeys: string[]): Promise<void>

  /**
   * Delete specific instance hash fields (admin retry paths clear error /
   * compensation fields) and drop any leftover TTLs on the data keys.
   */
  clearInstanceFields(instanceId: string, fields: string[]): Promise<void>

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

  // -- Reaper / admin primitives ---------------------------------------------
  // BullMQ-agnostic building blocks for the "state follows the job" lifecycle;
  // the worker/queue layer decides WHICH ids are dead (job key existence).
  // The index is sharded PER QUEUE: each bucket scales with one queue's own
  // retained-job count, never with its neighbours'.

  /** Queue names that ever created durable state (cheap registry read). */
  /**
   * Announce a durable queue (idempotent). Called by `DurableWorker` at
   * startup so dashboards can detect durable deployments BEFORE the first run
   * ever ticks (runs also register their queue on creation).
   */
  registerQueue(queueName: string): Promise<void>

  queues(): Promise<string[]>

  /** A queue's non-terminal instance ids (bounded by its in-flight work). */
  listActive(queueName: string): Promise<string[]>

  /** The oldest `limit` ids in a queue's terminal bucket (oldest first). */
  listOldestTerminal(queueName: string, status: TerminalStatus, limit: number): Promise<string[]>

  /** The newest `limit` ids in a queue's terminal bucket (newest first). */
  /**
   * A true offset page of one terminal bucket, ordered by terminal-transition
   * time (`order: "desc"` = newest first). Exact — backs `listRunsPage`.
   */
  listTerminalPage(
    queueName: string,
    status: TerminalStatus,
    query: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<string[]>

  listNewestTerminal(queueName: string, status: TerminalStatus, limit: number): Promise<string[]>

  /** Exact cardinality of a queue's terminal bucket. */
  countTerminal(queueName: string, status: TerminalStatus): Promise<number>

  /** Delete all state (and index entries) for the given instances of a queue. */
  removeInstances(queueName: string, instanceIds: string[]): Promise<void>

  /** Delete a queue's every instance + its index buckets (chunked; obliterate). */
  wipeQueue(queueName: string): Promise<void>

  /** Delete every queue known to the registry, then the registry itself. */
  wipeAll(): Promise<void>

  /** Of the given instance ids, which currently hold a live advisory lock? */
  heldLocks(instanceIds: string[]): Promise<Set<string>>

  /**
   * @deprecated 0.1.x stored logs in a durable list; this reads any leftover
   * entries during the transition window. Optional — stores without legacy
   * data simply omit it. Removed in 0.3.0.
   */
  legacyLogs?(instanceId: string): Promise<DurableLogEntry[]>

  // -- Lifecycle -----------------------------------------------------------

  /** Release any underlying resources (connections). */
  close(): Promise<void>
}
