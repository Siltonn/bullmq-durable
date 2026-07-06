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

import type { DurableInstanceDetail, DurableInstanceSummary, DurableStep } from "../../shared/dto"
import {
  classifyLocalStuck,
  deriveView,
  sleepWakeAt,
  type InstanceState,
  type StepState,
} from "bullmq-durable"
import { durationBetween, previewValue } from "../infra/util/preview"

/** When does this instance's lifetime "end" for duration purposes? */
function instanceEnd(instance: InstanceState, now: number): number {
  return (
    instance.completedAt ?? instance.failedAt ?? (isTerminal(instance) ? instance.updatedAt : now)
  )
}

function isTerminal(instance: InstanceState): boolean {
  return (
    instance.status === "completed" ||
    instance.status === "failed" ||
    instance.status === "compensation_failed" ||
    instance.status === "cancelled"
  )
}

export function toStep(step: StepState, now: number): DurableStep {
  // A `running` step is in-flight — including one parked between retries, which the
  // runtime records as `running` WITH a `failedAt` — so its duration grows to `now`.
  // Only a finished step freezes at its completed/failed time.
  const end = step.status === "running" ? now : (step.completedAt ?? step.failedAt)
  const sleepUntil = step.type === "sleep" ? sleepWakeAt(step) : undefined
  return {
    key: step.key,
    type: step.type,
    phase: step.phase ?? "main",
    status: step.status,
    attempts: step.attempts,
    seq: step.seq,
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

/** A forward (`main`-phase) work step — what "progress" should count. */
function isMainWorkStep(s: { type: StepState["type"]; phase?: string }): boolean {
  return s.type === "step" && (s.phase ?? "main") === "main"
}

export function toInstanceSummary(
  instance: InstanceState,
  steps: StepState[],
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
    // Count forward work steps (`ctx.step`) only: elapsed sleeps are waits, and
    // internal compensation/failure steps must not inflate forward progress.
    stepCount: steps.filter(isMainWorkStep).length,
    completedSteps: steps.filter((s) => isMainWorkStep(s) && s.status === "completed").length,
    runCount: instance.runCount,
    resumeSeq: instance.resumeSeq ?? 0,
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
  instance: InstanceState,
  steps: StepState[],
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
    failedStep: instance.failedStep,
    compensation: instance.compensation,
    steps: projected,
    stepCount: projected.filter(isMainWorkStep).length,
    completedSteps: projected.filter((s) => isMainWorkStep(s) && s.status === "completed").length,
  }
}
