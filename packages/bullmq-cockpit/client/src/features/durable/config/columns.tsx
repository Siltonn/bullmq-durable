import { Chip, Tooltip } from "@heroui/react"
import { useNavigate } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo } from "react"
import type { DurableInstanceSummary } from "@shared/dto"
import { ActionMenu, type ActionItem } from "@/components/ui/action-menu"
import { Countdown, RelativeTime } from "@/components/ui/relative-time"
import { DurableStatusChip } from "@/components/ui/status-badge"
import { api } from "@/lib/api"
import { formatDuration, truncate } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import { STUCK_LABELS } from "@/lib/status"
import type { usePermission } from "@/lib/providers/config"
import type { useConfirm } from "@/lib/providers/confirm"
import type { useCockpitAction } from "@/lib/providers/actions"

/** A compact step-progress glyph: one dot per step seen, filled when completed. */
function StepDots({ done, total }: { done: number; total: number }) {
  const shown = Math.min(total, 6)
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex gap-0.5">
        {Array.from({ length: shown }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full ${i < done ? "bg-success" : "bg-default-300"}`}
          />
        ))}
      </div>
      <span className="text-[11px] tabular-nums text-foreground-400">
        {done}/{total}
      </span>
    </div>
  )
}

export interface UseDurableColumnsOpts {
  navigate: ReturnType<typeof useNavigate>
  can: ReturnType<typeof usePermission>
  action: ReturnType<typeof useCockpitAction>
  confirm: ReturnType<typeof useConfirm>
}

export function useDurableColumns(
  opts: UseDurableColumnsOpts,
): ColumnDef<DurableInstanceSummary>[] {
  const { navigate, can, action, confirm } = opts

  return useMemo<ColumnDef<DurableInstanceSummary>[]>(() => {
    const resume = async (inst: DurableInstanceSummary) => {
      if (
        await confirm({
          title: "Resume now?",
          body: `Enqueue a resume tick for "${inst.id}".`,
          confirmLabel: "Resume",
          confirmColor: "primary",
        })
      )
        action.mutate(() => api.durableResume(inst.id))
    }
    const retry = async (inst: DurableInstanceSummary) => {
      if (
        await confirm({
          title: "Retry instance?",
          body: "Re-runs the failed step; completed steps stay cached.",
          confirmLabel: "Retry",
          confirmColor: "warning",
        })
      )
        action.mutate(() => api.durableRetry(inst.id))
    }
    const cancel = async (inst: DurableInstanceSummary) => {
      if (
        await confirm({
          title: "Cancel instance?",
          body: `Marks "${inst.id}" cancelled and stops it at the next step.`,
          confirmLabel: "Cancel instance",
          confirmColor: "warning",
        })
      )
        action.mutate(() => api.durableCancel(inst.id))
    }
    const del = async (inst: DurableInstanceSummary) => {
      if (
        await confirm({
          title: "Delete durable state?",
          body: `Deletes state for "${inst.id}" (steps, logs, instance). Business DB and BullMQ jobs are untouched.`,
          confirmLabel: "Delete state",
          confirmColor: "danger",
        })
      )
        action.mutate(() => api.durableDelete(inst.id))
    }

    return [
      {
        id: "instance",
        header: "Instance",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[13px] text-foreground-700">
              {truncate(row.original.id, 30)}
            </span>
            <span className="text-[13px] text-foreground-400">
              {row.original.queueName} · {row.original.jobName}
            </span>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <DurableStatusChip status={row.original.derivedStatus} />
            {row.original.stuck && (
              <Tooltip content={STUCK_LABELS[row.original.stuck]} size="sm">
                <Chip
                  size="sm"
                  variant="flat"
                  color="danger"
                  startContent={<CockpitIcon name="stuck" width={12} />}
                >
                  stuck
                </Chip>
              </Tooltip>
            )}
          </div>
        ),
      },
      {
        id: "step",
        header: "Current step",
        cell: ({ row }) => {
          const r = row.original
          return (
            <div className="flex flex-col gap-1">
              {r.currentStepKey ? (
                <div className="flex flex-col">
                  <span className="text-sm text-foreground-700">
                    {truncate(r.currentStepKey, 24)}
                  </span>
                  {r.currentAttempts !== undefined && (
                    <span className="text-xs text-foreground-400">attempt {r.currentAttempts}</span>
                  )}
                </div>
              ) : (
                <span className="text-foreground-300">—</span>
              )}
              {r.stepCount > 0 && <StepDots done={r.completedSteps} total={r.stepCount} />}
            </div>
          )
        },
      },
      {
        id: "next",
        header: "Next resume",
        cell: ({ row }) =>
          row.original.nextRunAt ? (
            <Countdown target={row.original.nextRunAt} />
          ) : (
            <span className="text-foreground-300">—</span>
          ),
      },
      {
        id: "duration",
        header: "Duration",
        cell: ({ row }) => (
          <span className="tabular-nums text-foreground-500">
            {formatDuration(row.original.durationMs)}
          </span>
        ),
      },
      {
        id: "updated",
        header: "Updated",
        cell: ({ row }) => (
          <span className="text-foreground-500">
            <RelativeTime value={row.original.updatedAt} />
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const inst = row.original
          const yielded = inst.status === "yielded"
          const running = inst.status === "running"
          const items: ActionItem[] = [
            {
              key: "open",
              label: "Open instance",
              icon: "chevronRight",
              onAction: () =>
                navigate({ to: "/durable/$instanceId", params: { instanceId: inst.id } }),
            },
            {
              key: "resume",
              label: "Resume now",
              icon: "resume",
              hidden: !can("durable:resume") || !(yielded || running),
              onAction: () => void resume(inst),
            },
            {
              key: "retry",
              label: "Retry",
              icon: "retry",
              hidden: !can("durable:retry") || inst.status !== "failed",
              onAction: () => void retry(inst),
            },
            {
              key: "cancel",
              label: "Cancel",
              icon: "cancel",
              color: "warning",
              hidden: !can("durable:cancel") || !(yielded || running),
              onAction: () => void cancel(inst),
            },
            {
              key: "delete",
              label: "Delete state",
              icon: "remove",
              color: "danger",
              hidden: !can("durable:delete"),
              onAction: () => void del(inst),
            },
          ]
          return (
            <div className="flex justify-end" onPointerDown={(e) => e.stopPropagation()}>
              <ActionMenu items={items} />
            </div>
          )
        },
      },
    ]
  }, [navigate, can, action, confirm])
}
