import { Chip } from "@heroui/react"
import type { ReactNode } from "react"
import type { DurableStep } from "@shared/dto"
import { JsonViewer } from "@/components/ui/json-viewer"
import { Countdown, RelativeTime } from "@/components/ui/relative-time"
import { StepStatusChip } from "@/components/ui/status-badge"
import { formatDateTime, formatDuration } from "@/lib/format"

/** One label → value line in the step popover (value right-aligned). */
function StepRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-foreground-400">
        {label}
      </span>
      <span className="truncate text-right text-sm tabular-nums text-foreground-700">
        {children}
      </span>
    </div>
  )
}

export function StepDetail({ step }: { step: DurableStep }) {
  return (
    <div className="space-y-3.5">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <StepStatusChip status={step.status} />
          <Chip size="sm" variant="flat" className="ml-auto capitalize">
            {step.type}
          </Chip>
        </div>
        <div className="break-all font-mono text-sm font-medium text-foreground">{step.key}</div>
      </div>

      <div className="divide-y divide-default-100 rounded-medium border border-default-200/60 px-3">
        <StepRow label="Attempts">{step.attempts}</StepRow>
        <StepRow label="Duration">{formatDuration(step.durationMs)}</StepRow>
        {step.startedAt && (
          <StepRow label="Started">
            <span title={formatDateTime(step.startedAt)}>
              <RelativeTime value={step.startedAt} />
            </span>
          </StepRow>
        )}
        {step.completedAt && (
          <StepRow label="Completed">
            <span title={formatDateTime(step.completedAt)}>
              <RelativeTime value={step.completedAt} />
            </span>
          </StepRow>
        )}
        {step.failedAt && (
          <StepRow label="Failed">
            <span title={formatDateTime(step.failedAt)}>
              <RelativeTime value={step.failedAt} />
            </span>
          </StepRow>
        )}
        {step.nextRunAt && (
          <StepRow label="Next run">
            <Countdown target={step.nextRunAt} />
          </StepRow>
        )}
        {step.type === "sleep" && step.sleepUntil && (
          <StepRow label="Resumes">
            <Countdown target={step.sleepUntil} />
          </StepRow>
        )}
      </div>

      {step.error && (
        <div className="rounded-medium border border-danger/30 bg-danger/5 p-2.5">
          <div className="text-xs font-semibold text-danger">{step.error.name}</div>
          <div className="mt-0.5 max-h-28 overflow-auto whitespace-pre-wrap break-words text-[13px] text-danger-600">
            {step.error.message}
          </div>
        </div>
      )}

      {step.type === "step" && step.resultPreview !== undefined && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400">
            Result
          </div>
          <JsonViewer value={step.resultPreview} maxHeight={176} />
        </div>
      )}
    </div>
  )
}
