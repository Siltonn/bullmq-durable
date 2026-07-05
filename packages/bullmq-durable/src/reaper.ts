/**
 * State reaper — enforces "state lives exactly as long as its BullMQ job".
 *
 * Terminal state carries no TTL. Instead, the reaper OBSERVES job existence:
 *  - `reapTerminal()` walks the oldest entries of each done bucket and deletes
 *    state whose bull job key is gone (write-time trigger: after every terminal
 *    transition; also on `cleaned` events and reads).
 *  - `reconcileActive()` walks the (bounded) active set and handles non-terminal
 *    orphans — instances whose job was bulk-removed under us (`clean('delayed')`,
 *    `drain()`, bull-board buttons). They are marked cancelled, then reaped.
 *
 * Everything is best-effort and idempotent: a missed pass is picked up by the
 * next trigger, and correctness never depends on any single one firing.
 */

import type { StateStore } from "./store/state-store"
import { isTerminalStatus, resumeJobId, TERMINAL_STATUSES } from "./utils/keys"

/** Batched bull-side existence check for job ids (same-queue). */
export type JobsExist = (jobIds: string[]) => Promise<boolean[]>

export interface DurableReaperOptions {
  store: StateStore
  queueName: string
  jobsExist: JobsExist
  /** Oldest entries checked per bucket per pass. Default 8. */
  batch?: number
  /** Min interval between fire-and-forget passes. Default 5s. */
  throttleMs?: number
  /**
   * An active instance whose job is missing is only treated as an orphan once
   * it has been quiet this long — absorbs the 0.1.x rolling-upgrade window
   * where "complete job A, enqueue resume B" is momentarily jobless. Default 60s.
   */
  graceMs?: number
}

export class DurableReaper {
  private readonly batch: number
  private readonly throttleMs: number
  private readonly graceMs: number
  private lastPass = 0
  private running = false

  constructor(private readonly opts: DurableReaperOptions) {
    this.batch = opts.batch ?? 8
    this.throttleMs = opts.throttleMs ?? 5_000
    this.graceMs = opts.graceMs ?? 60_000
  }

  /** instanceId = `${queueName}:${jobId}` — strip the fixed prefix back off. */
  private jobIdOf(instanceId: string): string {
    return instanceId.startsWith(`${this.opts.queueName}:`)
      ? instanceId.slice(this.opts.queueName.length + 1)
      : instanceId
  }

  /**
   * Fire-and-forget, throttled full pass (terminal reap; optionally the active
   * reconcile too). The post-terminal hot path calls this after every finished
   * run — the throttle keeps it amortised.
   */
  kick(options?: { reconcile?: boolean }): void {
    const now = Date.now()
    if (this.running || now - this.lastPass < this.throttleMs) return
    this.lastPass = now
    this.running = true
    void this.pass(options?.reconcile ?? false)
      .catch(() => {
        // Best-effort by design; the next trigger retries.
      })
      .finally(() => {
        this.running = false
      })
  }

  /** One full pass, un-throttled (used by explicit callers: drain, events, start). */
  async pass(reconcile: boolean): Promise<void> {
    if (reconcile) await this.reconcileActive()
    await this.reapTerminal()
  }

  /**
   * Delete terminal state whose job no longer exists. Walks each done bucket
   * oldest-first; keeps draining a bucket while the whole batch was dead (bulk
   * cleanups delete contiguous oldest runs), bounded to a few rounds per pass.
   */
  async reapTerminal(): Promise<number> {
    let reaped = 0
    for (const status of TERMINAL_STATUSES) {
      for (let round = 0; round < 4; round++) {
        // Buckets are per queue since 0.2.0 — no foreign-id filtering needed.
        const ids = await this.opts.store.listOldestTerminal(
          this.opts.queueName,
          status,
          this.batch,
        )
        if (ids.length === 0) break
        const exists = await this.opts.jobsExist(ids.map((id) => this.jobIdOf(id)))
        const dead = ids.filter((_, i) => !exists[i])
        if (dead.length > 0) {
          await this.opts.store.removeInstances(this.opts.queueName, dead)
          reaped += dead.length
        }
        // Oldest survivors still have live jobs — deeper entries are newer, stop.
        if (dead.length < ids.length || ids.length < this.batch) break
      }
    }
    return reaped
  }

  /**
   * Handle non-terminal orphans: active-set instances whose job disappeared
   * (bulk-removed behind our back). Marked cancelled — a short, observable
   * tombstone — then removed by the terminal reap that follows.
   */
  async reconcileActive(): Promise<number> {
    const ids = await this.opts.store.listActive(this.opts.queueName)
    if (ids.length === 0) return 0

    const exists = await this.opts.jobsExist(ids.map((id) => this.jobIdOf(id)))
    const now = Date.now()
    let orphans = 0

    for (let i = 0; i < ids.length; i++) {
      if (exists[i]) continue
      let instance
      try {
        instance = await this.opts.store.getInstance(ids[i]!)
      } catch {
        continue // one corrupted record must not brick the whole pass
      }
      if (!instance) continue
      // Grace window: don't misread a just-created instance racing its own job
      // write (or a mid-hand-off legacy tick) as an orphan.
      if (now - instance.updatedAt < this.graceMs) continue
      // Rolling-upgrade guard: a 0.1.x run may still be CARRIED by its legacy
      // resume job (possibly sleeping for days). Only the shim delivery migrates
      // it — reconcile must not cancel a run whose legacy carrier is alive.
      if (await this.legacyCarrierAlive(instance)) continue
      await this.opts.store.cancelInstance(ids[i]!)
      orphans += 1
    }
    return orphans
  }

  /** Whether a legacy (0.1.x) resume job still carries this run. Removed in 0.3.0. */
  private async legacyCarrierAlive(instance: {
    originalJobId: string
    resumeSeq?: number
  }): Promise<boolean> {
    if (!instance.resumeSeq || instance.resumeSeq <= 0) return false
    const [alive] = await this.opts.jobsExist([
      resumeJobId(instance.originalJobId, instance.resumeSeq),
    ])
    return alive === true
  }

  /**
   * Precise, single-instance follow of a `removed` queue event: terminal state
   * is reaped immediately; a non-terminal instance was hand-deleted mid-flight
   * — mark it cancelled, then reap.
   */
  async onJobRemoved(instanceId: string): Promise<void> {
    const instance = await this.opts.store.getInstance(instanceId)
    if (!instance) return
    if (!isTerminalStatus(instance.status)) {
      // The run may still ride a legacy 0.1.x resume job (the removed id was
      // the original). Leave it alone — the shim delivery will migrate it.
      if (await this.legacyCarrierAlive(instance)) return
      await this.opts.store.cancelInstance(instanceId)
    }
    await this.opts.store.removeInstances(this.opts.queueName, [instanceId])
  }
}

/**
 * Wire a host-provided `QueueEvents` to a reaper: `removed` handles the exact
 * instance (reap terminal / cancel a hand-deleted run); `cleaned` triggers a
 * batch reap+reconcile. Shared by DurableQueue.attachQueueEvents and
 * DurableWorker.attachQueueEvents. Returns the detach function.
 */
export function wireQueueEvents(
  queueEvents: {
    on(event: "removed", listener: (args: { jobId: string }) => void): unknown
    on(event: "cleaned", listener: () => void): unknown
    off(event: "removed", listener: (args: { jobId: string }) => void): unknown
    off(event: "cleaned", listener: () => void): unknown
  },
  reaper: DurableReaper,
  toInstanceId: (jobId: string) => string,
): () => void {
  const onRemoved = ({ jobId }: { jobId: string }) => {
    void reaper.onJobRemoved(toInstanceId(jobId)).catch(() => undefined)
  }
  const onCleaned = () => {
    void reaper.pass(true).catch(() => undefined)
  }
  queueEvents.on("removed", onRemoved)
  queueEvents.on("cleaned", onCleaned)
  return () => {
    queueEvents.off("removed", onRemoved)
    queueEvents.off("cleaned", onCleaned)
  }
}

/**
 * Build a {@link JobsExist} from anything QueueBase-shaped (a BullMQ `Queue` or
 * `Worker`): batched `EXISTS` on the job hash keys over the instance's own
 * connection — no extra client, no per-id `getJob` hydration.
 */
export function bullJobsExist(base: { toKey(id: string): string; client: Promise<unknown> }): JobsExist {
  return async (jobIds: string[]): Promise<boolean[]> => {
    if (jobIds.length === 0) return []
    // BullMQ's `client` is typed as a narrowed IRedisClient; EXISTS is present
    // on every real client (ioredis / cluster) even though the type omits it.
    const client = (await base.client) as { exists(...keys: string[]): Promise<number> }
    // One EXISTS per id (not one EXISTS with N keys) so each answer is exact.
    return Promise.all(jobIds.map(async (id) => (await client.exists(base.toKey(id))) === 1))
  }
}
