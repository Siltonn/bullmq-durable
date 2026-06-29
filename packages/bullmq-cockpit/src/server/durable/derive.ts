/**
 * Projection from the *stored* durable shapes onto the richer *wire* shapes the
 * dashboard renders.
 *
 * The runtime persists a deliberately small state machine — instances are only
 * ever `running | yielded | completed | failed | cancelled`, and a "sleep" is
 * just a completed step carrying a `resumeAt`. The dashboard wants more: it
 * should say "sleeping, resumes in 8s" or "retrying, attempt 12". We recover
 * that richer view here by reading the in-flight step, without the runtime ever
 * needing to store it.
 */

import type {
  DurableDerivedStatus,
  DurableEvent,
  DurableInstanceDetail,
  DurableInstanceSummary,
  DurableStep,
  StuckKind,
} from "../../shared/dto"
import { durationBetween, previewValue } from "../infra/util/preview"
import type { StoredInstanceState, StoredLog, StoredStepState } from "./protocol"

/** Pull `resumeAt` out of a sleep step's stored `{ resumeAt }` result. */
function sleepResumeAt(step: StoredStepState): number | undefined {
  const result = step.result
  if (result && typeof result === "object" && "resumeAt" in result) {
    const value = (result as { resumeAt?: unknown }).resumeAt
    if (typeof value === "number") return value
  }
  return undefined
}

/** True when a step is mid-flight: a `running` step that is scheduled to resume. */
function isInFlightRetry(step: StoredStepState): boolean {
  return step.status === "running" && step.nextRunAt !== undefined
}

interface DerivedView {
  derivedStatus: DurableDerivedStatus
  currentStep?: StoredStepState
  nextRunAt?: number
}

/**
 * Split the runtime's coarse `yielded` status into the UI's `sleeping` /
 * `retrying` / `waiting`, and pick out the step the instance is "parked" on.
 */
export function deriveView(instance: StoredInstanceState, steps: StoredStepState[]): DerivedView {
  switch (instance.status) {
    case "completed":
      return { derivedStatus: "completed" }
    case "failed":
      return { derivedStatus: "failed", currentStep: lastFailedStep(steps) }
    case "cancelled":
      return { derivedStatus: "cancelled" }
    case "running":
      return { derivedStatus: "running", currentStep: latestRunningStep(steps) }
    case "yielded": {
      // A retry/`retryLater` parks on a still-`running` step with a `nextRunAt`.
      const retrying = [...steps].reverse().find(isInFlightRetry)
      if (retrying) {
        return { derivedStatus: "retrying", currentStep: retrying, nextRunAt: retrying.nextRunAt }
      }
      // A sleep parks on the most recent `sleep` step whose `resumeAt` is set.
      const sleeping = [...steps]
        .reverse()
        .find((s) => s.type === "sleep" && sleepResumeAt(s) !== undefined)
      if (sleeping) {
        return {
          derivedStatus: "sleeping",
          currentStep: sleeping,
          nextRunAt: sleepResumeAt(sleeping),
        }
      }
      // Yielded but unclassifiable (e.g. a future waitForEvent primitive).
      return { derivedStatus: "waiting", currentStep: latestRunningStep(steps) }
    }
  }
}

function latestRunningStep(steps: StoredStepState[]): StoredStepState | undefined {
  return [...steps].reverse().find((s) => s.status === "running")
}

function lastFailedStep(steps: StoredStepState[]): StoredStepState | undefined {
  return [...steps].reverse().find((s) => s.status === "failed")
}

/**
 * Classify the two locally-detectable kinds of "stuck". The orphan kinds need
 * BullMQ correlation and are computed by the health inspector instead.
 */
export function classifyLocalStuck(
  instance: StoredInstanceState,
  view: DerivedView,
  now: number,
  thresholdMs: number,
): StuckKind | null {
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

/** When does this instance's lifetime "end" for duration purposes? */
function instanceEnd(instance: StoredInstanceState, now: number): number {
  return (
    instance.completedAt ?? instance.failedAt ?? (isTerminal(instance) ? instance.updatedAt : now)
  )
}

function isTerminal(instance: StoredInstanceState): boolean {
  return (
    instance.status === "completed" ||
    instance.status === "failed" ||
    instance.status === "cancelled"
  )
}

export function toStep(step: StoredStepState, now: number): DurableStep {
  // A `running` step is in-flight — including one parked between retries, which the
  // runtime records as `running` WITH a `failedAt` — so its duration grows to `now`.
  // Only a finished step freezes at its completed/failed time.
  const end = step.status === "running" ? now : (step.completedAt ?? step.failedAt)
  const sleepUntil = step.type === "sleep" ? sleepResumeAt(step) : undefined
  return {
    key: step.key,
    type: step.type,
    status: step.status,
    attempts: step.attempts,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    failedAt: step.failedAt,
    nextRunAt: step.nextRunAt,
    durationMs: durationBetween(step.startedAt, end),
    resultPreview: step.type === "step" ? previewValue(step.result) : undefined,
    sleepUntil,
    error: step.error,
  }
}

export function toInstanceSummary(
  instance: StoredInstanceState,
  steps: StoredStepState[],
  now: number,
  thresholdMs: number,
): DurableInstanceSummary {
  const view = deriveView(instance, steps)
  const stuck = classifyLocalStuck(instance, view, now, thresholdMs)
  return {
    id: instance.id,
    businessId: instance.originalJobId,
    queueName: instance.queueName,
    jobName: instance.jobName,
    originalJobId: instance.originalJobId,
    status: instance.status,
    derivedStatus: view.derivedStatus,
    currentStepKey: view.currentStep?.key,
    currentStepStatus: view.currentStep?.status,
    currentAttempts: view.currentStep?.attempts,
    currentMaxAttempts: undefined,
    // Count work steps (`ctx.step`) only: the runtime stores each `ctx.sleep` as a
    // completed step too, but elapsed sleeps are waits, not work progress.
    stepCount: steps.filter((s) => s.type === "step").length,
    completedSteps: steps.filter((s) => s.type === "step" && s.status === "completed").length,
    runCount: instance.runCount,
    resumeSeq: instance.resumeSeq,
    nextRunAt: view.nextRunAt,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    startedAt: instance.createdAt,
    completedAt: instance.completedAt,
    failedAt: instance.failedAt,
    durationMs: durationBetween(instance.createdAt, instanceEnd(instance, now)),
    stuck,
  }
}

export function toInstanceDetail(
  instance: StoredInstanceState,
  steps: StoredStepState[],
  now: number,
  thresholdMs: number,
): DurableInstanceDetail {
  const summary = toInstanceSummary(instance, steps, now, thresholdMs)
  const projected = steps.map((s) => toStep(s, now))
  return {
    ...summary,
    input: instance.input,
    output: instance.output,
    error: instance.error,
    steps: projected,
    stepCount: projected.filter((s) => s.type === "step").length,
    completedSteps: projected.filter((s) => s.type === "step" && s.status === "completed").length,
  }
}

/**
 * Build a unified, chronological timeline from the lifecycle timestamps, the
 * steps, and the logs. There is no stored "events" stream, so this is a pure
 * synthesis — handy for the instance detail view's activity feed.
 */
export function synthesizeEvents(
  instance: StoredInstanceState,
  steps: StoredStepState[],
  logs: StoredLog[],
): DurableEvent[] {
  const events: DurableEvent[] = []

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
      events.push({
        timestamp: step.failedAt ?? step.startedAt ?? step.nextRunAt,
        type: "retry",
        level: "warn",
        stepKey: step.key,
        message: `Step "${step.key}" scheduled to retry`,
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
      level: "info",
      message: log.message,
      meta: log.meta,
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
