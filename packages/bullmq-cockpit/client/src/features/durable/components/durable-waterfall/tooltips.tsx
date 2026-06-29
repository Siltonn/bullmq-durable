/**
 * Tooltip / popover content sub-components for the durable waterfall.
 */

import type { DurableEvent, DurableInstanceDetail, DurableStep } from "@shared/dto"
import { formatDateTime, formatDuration } from "@/lib/format"
import { durableStatusMeta, stepStatusMeta } from "@/lib/status"
import { chipTint } from "@/lib/tokens"
import { stepEnd } from "./model"

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** A label → value line inside a hover tooltip. */
export function TipLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-5 py-0.5">
      <span className="text-foreground-400">{label}</span>
      <span className="font-mono tabular-nums text-foreground-600">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-row tooltips
// ---------------------------------------------------------------------------

export function StepTip({ step, now }: { step: DurableStep; now: number }) {
  const meta = stepStatusMeta(step.status)
  return (
    <div className="min-w-[200px] px-1 py-1.5 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-foreground">
          {step.key}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${chipTint[meta.color]}`}
        >
          {meta.label}
        </span>
      </div>
      <TipLine
        label="Duration"
        value={formatDuration(step.durationMs ?? stepEnd(step, now) - (step.startedAt ?? now))}
      />
      {step.attempts > 1 && <TipLine label="Attempts" value={String(step.attempts)} />}
      {step.startedAt && <TipLine label="Started" value={formatDateTime(step.startedAt)} />}
      {step.completedAt && <TipLine label="Completed" value={formatDateTime(step.completedAt)} />}
      {step.failedAt && <TipLine label="Failed" value={formatDateTime(step.failedAt)} />}
      {step.type === "sleep" && step.sleepUntil && (
        <TipLine label="Resumes" value={formatDateTime(step.sleepUntil)} />
      )}
    </div>
  )
}

export function InstanceTip({ instance, now }: { instance: DurableInstanceDetail; now: number }) {
  const meta = durableStatusMeta(instance.derivedStatus)
  const start = instance.startedAt ?? instance.createdAt
  return (
    <div className="min-w-[200px] px-1 py-1.5 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {instance.jobName}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${chipTint[meta.color]}`}
        >
          {meta.label}
        </span>
      </div>
      <TipLine
        label="Duration"
        value={formatDuration(instance.durationMs ?? (instance.completedAt ?? now) - start)}
      />
      <TipLine label="Steps" value={`${instance.completedSteps}/${instance.stepCount}`} />
      <TipLine label="Started" value={formatDateTime(start)} />
      {instance.completedAt && (
        <TipLine label="Completed" value={formatDateTime(instance.completedAt)} />
      )}
      {instance.failedAt && <TipLine label="Failed" value={formatDateTime(instance.failedAt)} />}
    </div>
  )
}

export function EventTip({ event }: { event: DurableEvent }) {
  return (
    <div className="min-w-[180px] px-1 py-1.5 text-xs">
      <div className="font-medium text-foreground">{event.message}</div>
      <div className="mt-1 font-mono tabular-nums text-foreground-400">
        {formatDateTime(event.timestamp)}
      </div>
    </div>
  )
}
