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
import { resumeJobId, TERMINAL_STATUSES } from "./utils/keys"

/** Batched bull-side existence check for job ids (same-queue). */
export type JobsExist = (jobIds: string[]) => Promise<boolean[]>

export interface DurableReaperOptions {
  store: StateStore
  queueName: string
  jobsExist: JobsExist
  /** Oldest entries checked per bucket per pass. Default 32. */
  batch?: number
  /** Min interval between fire-and-forget passes. Default 5s. */
  throttleMs?: number
  /**
   * An active instance whose job is missing is only treated as an orphan once
   * it has been quiet this long — absorbs short races (a just-created instance
   * beating its job write, a mid-hand-off legacy tick). Default 10s.
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
    this.batch = opts.batch ?? 32
    this.throttleMs = opts.throttleMs ?? 5_000
    this.graceMs = opts.graceMs ?? 10_000
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
}

type ExistsCapable = { exists(key: string): Promise<number | string> }
type PipelineCapable = {
  pipeline(commands: Array<[string, ...string[]]>): {
    exec(): Promise<Array<[error: Error | null, result: unknown]> | null>
  }
}

/**
 * Build a {@link JobsExist} from anything QueueBase-shaped (a BullMQ `Queue` or
 * `Worker`): `EXISTS` on the job **hash keys** over the instance's own
 * connection — no extra client, no per-id `getJob` hydration.
 *
 * One `EXISTS` per key (a single variadic call only returns a count, not which
 * keys exist). Pipelined into one round trip when the client supports it
 * (ioredis does); falls back to concurrent per-key calls otherwise. On any
 * per-key error the key is reported as EXISTING — uncertainty must never make
 * the reaper delete live state.
 */
export function bullJobKeysExist(base: {
  toKey(id: string): string
  client: Promise<unknown>
}): JobsExist {
  return async (jobIds: string[]): Promise<boolean[]> => {
    if (jobIds.length === 0) return []
    // BullMQ types `client` as a narrowed IRedisClient without exists/pipeline;
    // guard at runtime instead of blindly asserting the shape.
    const client = (await base.client) as Partial<ExistsCapable & PipelineCapable>
    const keys = jobIds.map((id) => base.toKey(id))

    if (typeof client.pipeline === "function") {
      try {
        const results = await client.pipeline(keys.map((key) => ["exists", key])).exec()
        if (results && results.length === keys.length) {
          return results.map(([error, value]) => (error ? true : Number(value) === 1))
        }
      } catch {
        // Unexpected pipeline shape/failure — fall through to per-key EXISTS.
      }
    }
    if (typeof client.exists === "function") {
      const exists = client.exists.bind(client)
      return Promise.all(
        keys.map(async (key) => {
          try {
            return Number(await exists(key)) === 1
          } catch {
            return true // uncertain → treat as existing (never reap on doubt)
          }
        }),
      )
    }
    throw new TypeError(
      "bullJobKeysExist: the Redis client exposes neither pipeline() nor exists()",
    )
  }
}
