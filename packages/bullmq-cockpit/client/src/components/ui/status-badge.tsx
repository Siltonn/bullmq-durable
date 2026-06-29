/** Status chips: one component per status domain, each picking colour + icon. */

import { Chip } from "@heroui/react"
import type { DurableDerivedStatus, DurableStepStatus, JobState } from "@shared/dto"
import { CockpitIcon } from "@/lib/icons"
import { durableStatusMeta, jobStateMeta, stepStatusMeta, type StatusMeta } from "@/lib/status"

interface ChipProps {
  size?: "sm" | "md"
  spin?: boolean
}

function StatusChip({ meta, size = "sm", spin }: { meta: StatusMeta } & ChipProps) {
  return (
    <Chip
      size={size}
      color={meta.color}
      variant="flat"
      startContent={
        <CockpitIcon name={meta.icon} width={14} className={spin ? "animate-spin" : undefined} />
      }
      classNames={{ content: "font-medium" }}
    >
      {meta.label}
    </Chip>
  )
}

export function JobStateChip({ state, size }: { state: JobState } & ChipProps) {
  return <StatusChip meta={jobStateMeta(state)} size={size} spin={state === "active"} />
}

export function DurableStatusChip({
  status,
  size,
}: {
  status: DurableDerivedStatus
} & ChipProps) {
  return (
    <StatusChip
      meta={durableStatusMeta(status)}
      size={size}
      spin={status === "running" || status === "retrying"}
    />
  )
}

export function StepStatusChip({ status, size }: { status: DurableStepStatus } & ChipProps) {
  return <StatusChip meta={stepStatusMeta(status)} size={size} spin={status === "running"} />
}
