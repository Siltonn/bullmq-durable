/**
 * {@link DurableRun} — the run-scoped entity, `bullmq-durable`'s counterpart to
 * BullMQ's `Job`.
 *
 * A run is one durable execution: one BullMQ job plus its persisted instance
 * state and steps. This class carries every read and action that targets a
 * single run — dashboards, ops scripts and application code all use the same
 * object; nothing here is "admin only".
 *
 * Handles are cheap and created by their owning queue —
 * `queue.run(jobId)` / `queue.getRun(jobId)` / `queue.listRuns(...)` — the same
 * way `Job` instances come from a `Queue`. Everything goes through the
 * {@link StateStore} contract and plain BullMQ `Queue` APIs; no raw key access.
 */

import type { Queue } from "bullmq"
import { synthesizeEvents, type DurableRunEvent } from "./inspect/derive"
import { summarizeInstances, type DurableRunSummary } from "./inspect/summarize"
import type { StateStore } from "./store/state-store"
import type { DurableLogEntry, InstanceState, StepState } from "./types"
import { createInstanceId, resumeJobId } from "./utils/keys"
import { parseJobLogs, serializeLogEntry } from "./utils/log"

/** Thrown by run actions; `code` maps cleanly onto HTTP semantics. */
export class DurableActionError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_state",
  ) {
    super(message)
    this.name = "DurableActionError"
  }
}

/** The run's (single) BullMQ job — with the 0.1.x legacy-carrier fallback. */
export interface DurableCarrier {
  jobId: string
  /** True when the job is a 0.1.x resume job still carrying the run. */
  legacy: boolean
}

/**
 * What a run needs from its owning queue. Provided by {@link DurableQueue};
 * not constructed by consumers directly.
 *
 * @internal
 */
export interface DurableRunContext {
  readonly queueName: string
  readonly store: StateStore
  /** The queue's underlying BullMQ `Queue`. */
  bull(): Queue
  /** Nudge the queue's reaper (read-time reap trigger). */
  kickReaper(): void
}

export class DurableRun {
  /** The durable instance id (`{queue}:{jobId}` — treat as opaque). */
  readonly id: string
  readonly queueName: string
  /** The run's BullMQ job id. */
  readonly jobId: string

  private cached?: InstanceState

  /** @internal — obtain runs from `DurableQueue.run()` / `getRun()` / `listRuns()`. */
  constructor(
    private readonly ctx: DurableRunContext,
    jobId: string | number,
    snapshot?: InstanceState,
  ) {
    this.queueName = ctx.queueName
    this.jobId = String(jobId)
    this.id = createInstanceId(ctx.queueName, this.jobId)
    this.cached = snapshot
  }

  /**
   * The instance state from the fetch that produced this handle (or the last
   * `state()` call). May be stale; `state()` refreshes it.
   */
  get snapshot(): InstanceState | undefined {
    return this.cached
  }

  // -- Reads -----------------------------------------------------------------

  /** Fetch the run's instance state (refreshes {@link snapshot}). */
  async state(): Promise<InstanceState | null> {
    const instance = await this.ctx.store.getInstance(this.id)
    if (instance) {
      this.cached = instance
      // Read-time reap: state whose job has disappeared is on borrowed time —
      // this read is one of the triggers that collects it.
      this.ctx.kickReaper()
    }
    return instance
  }

  /** All recorded steps (forward, compensation and failure phases). */
  async steps(): Promise<StepState[]> {
    return this.ctx.store.getSteps(this.id)
  }

  /**
   * The run's log entries. The BullMQ job log is the source of truth (tagged
   * JSON lines written by `ctx.log`); a leftover 0.1.x durable log list and a
   * legacy resume-job carrier are merged in transitionally (removed in 0.3.0).
   * Once the job is cleaned away its logs are gone too.
   */
  async logs(): Promise<DurableLogEntry[]> {
    const instance = this.cached ?? (await this.state())

    const jobIds = [this.jobId]
    if (instance?.resumeSeq && instance.resumeSeq > 0) {
      jobIds.push(resumeJobId(instance.originalJobId, instance.resumeSeq))
    }
    const [legacy, ...jobLogs] = await Promise.all([
      instance
        ? (this.ctx.store.legacyLogs?.(this.id) ?? Promise.resolve([] as DurableLogEntry[]))
        : Promise.resolve([] as DurableLogEntry[]),
      ...jobIds.map((jobId) =>
        this.ctx
          .bull()
          .getJobLogs(jobId)
          .then(({ logs }) => parseJobLogs(logs))
          .catch(() => [] as DurableLogEntry[]),
      ),
    ])

    const out = [...legacy, ...jobLogs.flat()]
    // Foreign (raw) lines carry no timestamp; backfill from the previous
    // parsed line so timestamp-sorted timelines keep them in place.
    let lastTs = instance?.createdAt ?? 0
    for (const entry of out) {
      if (entry.kind === "raw" && entry.timestamp === 0) entry.timestamp = lastTs
      else if (entry.timestamp > 0) lastTs = entry.timestamp
    }
    return out
  }

  /** The unified event timeline (lifecycle + steps + logs). */
  async events(): Promise<DurableRunEvent[]> {
    const instance = await this.state()
    if (!instance) return []
    const [steps, logs] = await Promise.all([this.steps(), this.logs()])
    return synthesizeEvents(instance, steps, logs)
  }

  /**
   * State + steps + derived view + stuck classification in one shape, or
   * `null` when the run has no durable state.
   */
  async summary(options: { stuckThresholdMs: number }): Promise<DurableRunSummary | null> {
    const instance = await this.state()
    if (!instance) return null
    const [summary] = await summarizeInstances(this.ctx.store, [instance], options)
    return summary ?? null
  }

  // -- Carrier resolution (single source of the legacy fallback) --------------

  /** Resolve the run's job id, preferring the primary; legacy as fallback. */
  async carrier(): Promise<DurableCarrier | null> {
    const bull = this.ctx.bull()
    if (await bull.getJob(this.jobId).catch(() => undefined)) {
      return { jobId: this.jobId, legacy: false }
    }
    const instance = this.cached ?? (await this.state())
    if (instance?.resumeSeq && instance.resumeSeq > 0) {
      const legacyId = resumeJobId(instance.originalJobId, instance.resumeSeq)
      if (await bull.getJob(legacyId).catch(() => undefined)) {
        return { jobId: legacyId, legacy: true }
      }
    }
    return null
  }

  /** The carrier job's BullMQ state, or `"missing"` when it is gone. */
  async carrierState(): Promise<string> {
    const carrier = await this.carrier()
    if (!carrier) return "missing"
    const job = await this.ctx
      .bull()
      .getJob(carrier.jobId)
      .catch(() => undefined)
    if (!job) return "missing"
    return job.getState().catch(() => "unknown")
  }

  // -- Actions -----------------------------------------------------------------

  /** Re-deliver the run now: promote if delayed, retry if finished, revive if gone. */
  async resume(): Promise<void> {
    const instance = await this.requireState()
    if (instance.status === "completed" || instance.status === "cancelled") {
      throw new DurableActionError(`Cannot resume a ${instance.status} run`, "invalid_state")
    }
    if (instance.status === "failed") {
      throw new DurableActionError("Use retry to re-run a failed run", "invalid_state")
    }
    if (instance.status === "compensation_failed") {
      throw new DurableActionError(
        "Use retryCompensation to re-drive a compensation_failed run",
        "invalid_state",
      )
    }
    await this.reviveJob(instance)
    await this.appendActionLog("Resume requested", { action: "resume" })
  }

  /**
   * Re-run a terminally-failed run from its failure point: failed step records
   * are reset (completed steps stay cached), the run re-enters `running`, and
   * its job is retried/revived.
   */
  async retry(): Promise<void> {
    const instance = await this.requireState()
    if (instance.status !== "failed") {
      throw new DurableActionError("Retry only applies to failed runs", "invalid_state")
    }
    const failed = (await this.steps()).filter((s) => s.status === "failed")
    await this.ctx.store.removeSteps(
      this.id,
      failed.map((s) => storageKeyOf(s)),
    )
    await this.ctx.store.clearInstanceFields(this.id, [
      "error",
      "failedAt",
      "failureError",
      "failedStep",
      "compensation",
    ])
    await this.ctx.store.updateInstance(this.id, { status: "running" })
    await this.reviveJob(instance)
    await this.appendActionLog("Retry requested", { action: "retry" })
  }

  /**
   * Re-drive a `compensation_failed` run's compensation: only the FAILED
   * internal (compensation/failure-phase) steps are reset — already-succeeded
   * compensations stay cached — then the run re-enters `compensating`.
   */
  async retryCompensation(): Promise<void> {
    const instance = await this.requireState()
    if (instance.status !== "compensation_failed") {
      throw new DurableActionError(
        "retryCompensation only applies to compensation_failed runs",
        "invalid_state",
      )
    }
    const failedInternal = (await this.steps()).filter(
      (s) => (s.phase === "compensation" || s.phase === "failure") && s.status === "failed",
    )
    await this.ctx.store.removeSteps(
      this.id,
      failedInternal.map((s) => storageKeyOf(s)),
    )
    // `failureError` / `failedStep` are kept so the resumed sequence matches
    // the original trigger.
    await this.ctx.store.clearInstanceFields(this.id, ["error", "failedAt", "compensation"])
    await this.ctx.store.updateInstance(this.id, { status: "compensating" })
    await this.reviveJob(instance)
    await this.appendActionLog("Retry compensation requested", { action: "retry-compensation" })
  }

  /**
   * Cancel the run: mark the state, then best-effort remove its job. Strict —
   * throws on terminal runs; the lenient application-side path is
   * `DurableQueue.cancel(jobId)` (idempotent, works before the first tick).
   */
  async cancel(): Promise<void> {
    const instance = await this.requireState()
    if (instance.status === "completed" || instance.status === "cancelled") {
      throw new DurableActionError(`Cannot cancel a ${instance.status} run`, "invalid_state")
    }
    // Log BEFORE removing the job — the log line lives on that job.
    await this.appendActionLog("Cancelled", { action: "cancel" })
    await this.ctx.store.cancelInstance(this.id)
    await removeCarrierJobs(this.ctx.bull(), instance)
    this.ctx.kickReaper()
  }

  /** Delete the run's durable state (and its job, so it cannot resurrect). */
  async delete(): Promise<void> {
    const instance = await this.requireState()
    await removeCarrierJobs(this.ctx.bull(), instance)
    await this.ctx.store.removeInstances(this.queueName, [this.id])
  }

  // -- Internals ---------------------------------------------------------------

  private async requireState(): Promise<InstanceState> {
    const instance = await this.state()
    if (!instance) {
      throw new DurableActionError(`Durable run "${this.id}" not found`, "not_found")
    }
    return instance
  }

  private async reviveJob(instance: InstanceState): Promise<void> {
    const bull = this.ctx.bull()
    const carrier = await this.carrier()

    if (carrier) {
      const job = await bull.getJob(carrier.jobId).catch(() => undefined)
      if (job) {
        const state = await job.getState().catch(() => "unknown")
        if (state === "delayed") {
          await job.promote()
          return
        }
        if (state === "failed") {
          await job.retry()
          return
        }
        if (state === "completed") {
          await job.retry("completed")
          return
        }
        return // waiting / active / prioritized: it will run without our help
      }
    }

    // Job gone: revive with the same id from the persisted input. Replays are
    // idempotent — completed steps are cache hits.
    await bull.add(instance.jobName, instance.input, { jobId: instance.originalJobId })
  }

  private async appendActionLog(message: string, meta: Record<string, unknown>): Promise<void> {
    try {
      const carrier = await this.carrier()
      if (!carrier) return
      const job = await this.ctx.bull().getJob(carrier.jobId)
      if (!job) return
      await job.log(
        serializeLogEntry({
          message,
          timestamp: Date.now(),
          kind: "log",
          meta: { source: "ops", ...meta },
        }),
      )
    } catch {
      // Best effort — logging must never fail an action.
    }
  }
}

/**
 * Remove every job that may be carrying the run (primary + 0.1.x legacy
 * resume job), swallowing lock/availability errors. Shared by
 * `DurableRun.cancel/delete` and `DurableQueue.cancel`.
 *
 * @internal
 */
export async function removeCarrierJobs(
  bull: Queue,
  instance: Pick<InstanceState, "originalJobId" | "resumeSeq">,
): Promise<void> {
  const jobIds = [instance.originalJobId]
  if (instance.resumeSeq && instance.resumeSeq > 0) {
    jobIds.push(resumeJobId(instance.originalJobId, instance.resumeSeq))
  }
  for (const jobId of jobIds) {
    try {
      const job = await bull.getJob(jobId)
      if (job) await job.remove().catch(() => undefined)
    } catch {
      // Best effort.
    }
  }
}

/** A step's storage field (phase-namespaced), reconstructed from its state. */
function storageKeyOf(step: StepState): string {
  if (step.phase === "compensation") return `__rollback__:${step.key}`
  if (step.phase === "failure") return `__failure__:${step.key}`
  return step.key
}
