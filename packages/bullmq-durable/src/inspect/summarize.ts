/**
 * Batch summarization over persisted state: instance + steps + derived view +
 * stuck classification, in one shape dashboards can render directly.
 *
 * This is I/O over the {@link StateStore} contract (steps and lock probes),
 * kept out of `derive.ts` so that module stays pure. It is queue-agnostic —
 * callers may batch instances from several queues into one call, which keeps
 * the lock probe a single round trip.
 *
 * Entry points: `DurableRun.summary()` for one run, `DurableQueue.summarizeRuns`
 * for a queue's collection, or call {@link summarizeInstances} directly with
 * already-loaded instances.
 */

import type { StateStore } from "../store/state-store"
import type { InstanceState, StepState } from "../types"
import {
  classifyLocalStuck,
  deriveView,
  type DurableDerivedView,
  type DurableStuckKind,
} from "./derive"

export interface DurableRunSummary {
  instance: InstanceState
  view: DurableDerivedView
  steps: StepState[]
  stuck: DurableStuckKind | null
  /** Forward (`main`-phase) step counts — what a progress bar should show. */
  stepCount: number
  completedSteps: number
}

export interface SummarizeOptions {
  /** Age beyond which a parked/running run is classified stuck. */
  stuckThresholdMs: number
  /** Injectable clock (tests); defaults to `Date.now()`. */
  now?: number
}

/** Statuses whose derived view depends on their steps. */
const STEP_HUNGRY = new Set(["running", "yielded", "compensating", "failed", "compensation_failed"])

/**
 * Summarize already-loaded instances: fetch steps for step-hungry statuses,
 * derive the dashboard-grade view, and classify stuck — with `running_stale`
 * suppressed while the run's advisory lock is live (a held lock means a worker
 * is actively mid-step, not stale).
 */
export async function summarizeInstances(
  store: StateStore,
  instances: InstanceState[],
  options: SummarizeOptions,
): Promise<DurableRunSummary[]> {
  const now = options.now ?? Date.now()

  const stepsById = new Map<string, StepState[]>()
  for (const instance of instances) {
    if (STEP_HUNGRY.has(instance.status)) {
      stepsById.set(instance.id, await store.getSteps(instance.id))
    }
  }
  const runningIds = instances.filter((i) => i.status === "running").map((i) => i.id)
  const locked = await store.heldLocks(runningIds)

  return instances.map((instance) => {
    const steps = stepsById.get(instance.id) ?? []
    const view = deriveView(instance, steps)
    let stuck = classifyLocalStuck(instance, view, now, options.stuckThresholdMs)
    if (stuck === "running_stale" && locked.has(instance.id)) stuck = null
    const mainSteps = steps.filter((s) => (s.phase ?? "main") === "main")
    return {
      instance,
      view,
      steps,
      stuck,
      stepCount: mainSteps.length,
      completedSteps: mainSteps.filter((s) => s.status === "completed").length,
    }
  })
}
