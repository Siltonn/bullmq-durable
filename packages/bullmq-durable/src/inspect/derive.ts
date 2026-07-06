/**
 * Semantic derivations over persisted durable state — the runtime's own
 * knowledge, exposed so dashboards and tooling never re-implement it.
 *
 * The store persists a deliberately small machine (`running | yielded |
 * compensating | …`); consumers usually want more: "sleeping, resumes in 8s",
 * "retrying, attempt 12", a unified event timeline. These pure functions
 * recover that richer view from an instance + its steps (+ its log entries).
 */

import type { DurableLogEntry, InstanceState, StepState } from "../types"

// ---------------------------------------------------------------------------
// Derived status
// ---------------------------------------------------------------------------

/** The dashboard-grade status: `yielded` split into sleeping/retrying/waiting. */
export type DurableDerivedStatus =
  | "running"
  | "sleeping"
  | "retrying"
  | "waiting"
  | "compensating"
  | "completed"
  | "failed"
  | "compensation_failed"
  | "cancelled"

export interface DurableDerivedView {
  derivedStatus: DurableDerivedStatus
  /** The step the run is parked on / failed at, when one applies. */
  currentStep?: StepState
  /** When the run is due to move again (sleep wake / retry due). */
  nextRunAt?: number
}

/**
 * A sleep's wake time. 0.2.x persists sleeps as `running` with `nextRunAt`;
 * 0.1.x stored them completed with a `{ resumeAt }` result (legacy, read-only).
 */
export function sleepWakeAt(step: StepState): number | undefined {
  if (step.nextRunAt !== undefined) return step.nextRunAt
  const result = step.result
  if (result && typeof result === "object" && "resumeAt" in result) {
    const value = (result as { resumeAt?: unknown }).resumeAt
    if (typeof value === "number") return value
  }
  return undefined
}

/** True when a STEP (not a sleep) is mid-flight, scheduled to retry. */
function isInFlightRetry(step: StepState): boolean {
  return step.type === "step" && step.status === "running" && step.nextRunAt !== undefined
}

function latestRunningStep(steps: StepState[]): StepState | undefined {
  return [...steps].reverse().find((s) => s.status === "running")
}

function lastFailedMainStep(steps: StepState[]): StepState | undefined {
  // Only forward (`main`-phase) failures are the "point of failure" a user
  // debugs; internal __rollback__/__failure__ steps must not surface here.
  return [...steps].reverse().find((s) => s.status === "failed" && (s.phase ?? "main") === "main")
}

/** Split the coarse persisted status into the dashboard-grade view. */
export function deriveView(instance: InstanceState, steps: StepState[]): DurableDerivedView {
  switch (instance.status) {
    case "completed":
      return { derivedStatus: "completed" }
    case "failed":
      return { derivedStatus: "failed", currentStep: lastFailedMainStep(steps) }
    case "compensation_failed":
      return { derivedStatus: "compensation_failed", currentStep: lastFailedMainStep(steps) }
    case "cancelled":
      return { derivedStatus: "cancelled" }
    case "running":
      return { derivedStatus: "running", currentStep: latestRunningStep(steps) }
    case "compensating":
      return {
        derivedStatus: "compensating",
        currentStep: latestRunningStep(steps) ?? lastFailedMainStep(steps),
      }
    case "yielded": {
      const retrying = [...steps].reverse().find(isInFlightRetry)
      if (retrying) {
        return { derivedStatus: "retrying", currentStep: retrying, nextRunAt: retrying.nextRunAt }
      }
      const sleeping = [...steps]
        .reverse()
        .find((s) => s.type === "sleep" && sleepWakeAt(s) !== undefined)
      if (sleeping) {
        return {
          derivedStatus: "sleeping",
          currentStep: sleeping,
          nextRunAt: sleepWakeAt(sleeping),
        }
      }
      // Yielded with nothing parked on a step: e.g. a non-step error waiting
      // out BullMQ's own attempts/backoff.
      return { derivedStatus: "waiting", currentStep: latestRunningStep(steps) }
    }
  }
}

// ---------------------------------------------------------------------------
// Stuck classification
// ---------------------------------------------------------------------------

export type DurableStuckKind =
  | "running_stale"
  | "resume_missed"
  | "orphan_resume_job"
  | "orphan_instance"

/**
 * The two locally-detectable stuck kinds (no BullMQ correlation needed).
 * Orphan kinds require checking the run's job — see `DurableAdmin.carrierState`.
 */
export function classifyLocalStuck(
  instance: InstanceState,
  view: DurableDerivedView,
  now: number,
  thresholdMs: number,
): DurableStuckKind | null {
  if (instance.status === "running" && now - instance.updatedAt > thresholdMs) {
    return "running_stale"
  }
  if (
    instance.status === "yielded" &&
    view.nextRunAt !== undefined &&
    now - view.nextRunAt > thresholdMs
  ) {
    return "resume_missed"
  }
  return null
}

// ---------------------------------------------------------------------------
// Event timeline
// ---------------------------------------------------------------------------

/** A unified, chronological timeline entry synthesized from state + logs. */
export interface DurableRunEvent {
  timestamp: number
  type: "instance" | "step" | "sleep" | "retry" | "log" | "error"
  level: "info" | "warn" | "error"
  message: string
  stepKey?: string
  meta?: Record<string, unknown>
}

/** Synthesize the run's event feed from lifecycle timestamps, steps and logs. */
export function synthesizeEvents(
  instance: InstanceState,
  steps: StepState[],
  logs: DurableLogEntry[] = [],
): DurableRunEvent[] {
  const events: DurableRunEvent[] = []

  events.push({
    timestamp: instance.createdAt,
    type: "instance",
    level: "info",
    message: `Instance created on queue "${instance.queueName}" (job "${instance.jobName}")`,
  })

  for (const step of steps) {
    if (step.startedAt !== undefined) {
      events.push({
        timestamp: step.startedAt,
        type: step.type === "sleep" ? "sleep" : "step",
        level: "info",
        stepKey: step.key,
        message:
          step.type === "sleep"
            ? `Sleep "${step.key}" started`
            : `Step "${step.key}" started (attempt ${step.attempts})`,
      })
    }
    if (step.nextRunAt !== undefined && step.status === "running") {
      const isSleep = step.type === "sleep"
      events.push({
        timestamp: step.failedAt ?? step.startedAt ?? step.nextRunAt,
        type: isSleep ? "sleep" : "retry",
        level: isSleep ? "info" : "warn",
        stepKey: step.key,
        message: isSleep
          ? `Sleeping until ${new Date(step.nextRunAt).toISOString()}`
          : `Step "${step.key}" scheduled to retry`,
        meta: { nextRunAt: step.nextRunAt, attempts: step.attempts },
      })
    }
    if (step.status === "completed" && step.completedAt !== undefined) {
      events.push({
        timestamp: step.completedAt,
        type: step.type === "sleep" ? "sleep" : "step",
        level: "info",
        stepKey: step.key,
        message:
          step.type === "sleep" ? `Sleep "${step.key}" elapsed` : `Step "${step.key}" completed`,
      })
    }
    if (step.status === "failed" && step.failedAt !== undefined) {
      events.push({
        timestamp: step.failedAt,
        type: "error",
        level: "error",
        stepKey: step.key,
        message: `Step "${step.key}" failed: ${step.error?.message ?? "unknown error"}`,
      })
    }
  }

  for (const log of logs) {
    events.push({
      timestamp: log.timestamp,
      type: "log",
      level: log.kind === "event" && log.event === "step_failed" ? "error" : "info",
      message: log.message,
      ...(log.step !== undefined ? { stepKey: log.step } : {}),
      ...(log.meta !== undefined ? { meta: log.meta } : {}),
    })
  }

  if (instance.completedAt !== undefined) {
    events.push({
      timestamp: instance.completedAt,
      type: "instance",
      level: "info",
      message: "Instance completed",
    })
  }
  if (instance.failedAt !== undefined) {
    events.push({
      timestamp: instance.failedAt,
      type: "error",
      level: "error",
      message: `Instance failed: ${instance.error?.message ?? "unknown error"}`,
    })
  }

  return events.sort((a, b) => a.timestamp - b.timestamp)
}
