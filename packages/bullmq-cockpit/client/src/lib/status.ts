/**
 * Presentation metadata for every status the dashboard renders: a label, a
 * HeroUI chip colour, and an icon from the registry. Kept in one place so the
 * colour language stays consistent across tables, badges, and the timeline.
 */

import type { DurableDerivedStatus, DurableStepStatus, JobState, StuckKind } from "@shared/dto"
import type { IconName } from "./icons"

export type ChipColor = "default" | "primary" | "secondary" | "success" | "warning" | "danger"

export interface StatusMeta {
  label: string
  color: ChipColor
  icon: IconName
}

const JOB_STATE: Record<JobState, StatusMeta> = {
  completed: { label: "Completed", color: "success", icon: "completed" },
  failed: { label: "Failed", color: "danger", icon: "failed" },
  active: { label: "Active", color: "secondary", icon: "active" },
  waiting: { label: "Waiting", color: "default", icon: "waiting" },
  "waiting-children": { label: "Waiting (children)", color: "default", icon: "waiting" },
  delayed: { label: "Delayed", color: "warning", icon: "delayed" },
  paused: { label: "Paused", color: "default", icon: "paused" },
  prioritized: { label: "Prioritized", color: "default", icon: "active" },
  unknown: { label: "Unknown", color: "default", icon: "info" },
}

export function jobStateMeta(state: JobState): StatusMeta {
  return JOB_STATE[state] ?? JOB_STATE.unknown
}

const DURABLE_STATUS: Record<DurableDerivedStatus, StatusMeta> = {
  running: { label: "Running", color: "secondary", icon: "running" },
  sleeping: { label: "Sleeping", color: "default", icon: "sleeping" },
  retrying: { label: "Retrying", color: "warning", icon: "retrying" },
  waiting: { label: "Waiting", color: "default", icon: "waiting" },
  compensating: { label: "Compensating", color: "warning", icon: "compensating" },
  completed: { label: "Completed", color: "success", icon: "completed" },
  failed: { label: "Failed", color: "danger", icon: "failed" },
  compensation_failed: { label: "Compensation failed", color: "danger", icon: "compensationFailed" },
  cancelled: { label: "Cancelled", color: "default", icon: "cancelled" },
}

export function durableStatusMeta(status: DurableDerivedStatus): StatusMeta {
  return DURABLE_STATUS[status] ?? DURABLE_STATUS.waiting
}

const STEP_STATUS: Record<DurableStepStatus, StatusMeta> = {
  completed: { label: "Completed", color: "success", icon: "completed" },
  running: { label: "Running", color: "secondary", icon: "running" },
  failed: { label: "Failed", color: "danger", icon: "failed" },
  sleeping: { label: "Sleeping", color: "default", icon: "sleeping" },
  skipped: { label: "Skipped", color: "default", icon: "info" },
}

export function stepStatusMeta(status: DurableStepStatus): StatusMeta {
  return STEP_STATUS[status] ?? STEP_STATUS.skipped
}

export const STUCK_LABELS: Record<StuckKind, string> = {
  running_stale: "Running (stale)",
  resume_missed: "Resume missed",
  orphan_resume_job: "Orphan resume job",
  orphan_instance: "Orphan instance",
}
