import { Chip, Tooltip } from "@heroui/react"
import type { ColumnDef } from "@tanstack/react-table"
import { useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"
import type { QueueSummary } from "@shared/dto"
import { ActionMenu, type ActionItem } from "@/components/ui/action-menu"
import { CompositionBar } from "@/components/ui/composition-bar"
import { CockpitIcon } from "@/lib/icons"
import { formatNumber } from "@/lib/format"
import type { ChipColor } from "@/lib/status"
import type { usePermission } from "@/lib/providers/config"
import type { useConfirm } from "@/lib/providers/confirm"
import type { useCockpitAction } from "@/lib/providers/actions"
import { api } from "@/lib/api"

function NumCell({ value, color }: { value: number; color?: string }) {
  return (
    <span className={`tabular-nums ${value > 0 && color ? color : "text-foreground-500"}`}>
      {formatNumber(value)}
    </span>
  )
}

/** A live-state label derived from a queue's counts + worker presence. */
function queueHealth(q: QueueSummary): { label: string; color: ChipColor } {
  const pending = q.counts.waiting + q.counts.delayed + q.counts["waiting-children"]
  if (q.isPaused) return { label: "Paused", color: "warning" }
  if (q.counts.active > 0) return { label: "Processing", color: "primary" }
  if (pending > 0 && q.workers === 0) return { label: "No workers", color: "danger" }
  if (pending > 0) return { label: "Queued", color: "secondary" }
  return { label: "Idle", color: "default" }
}

export interface UseQueueColumnsOpts {
  navigate: ReturnType<typeof useNavigate>
  can: ReturnType<typeof usePermission>
  action: ReturnType<typeof useCockpitAction>
  confirm: ReturnType<typeof useConfirm>
}

export function useQueueColumns(opts: UseQueueColumnsOpts): ColumnDef<QueueSummary>[] {
  const { navigate, can, action, confirm } = opts

  return useMemo<ColumnDef<QueueSummary>[]>(() => {
    const pause = async (q: QueueSummary) => {
      if (
        await confirm({
          title: "Pause queue?",
          body: `Jobs on "${q.name}" won't be processed until resumed.`,
          confirmLabel: "Pause",
          confirmColor: "warning",
        })
      )
        action.mutate(() => api.pauseQueue(q.name))
    }
    const resume = async (q: QueueSummary) => {
      if (
        await confirm({
          title: "Resume queue?",
          body: `Jobs on "${q.name}" will start processing again.`,
          confirmLabel: "Resume",
          confirmColor: "primary",
        })
      )
        action.mutate(() => api.resumeQueue(q.name))
    }
    const clean = async (q: QueueSummary) => {
      if (
        await confirm({
          title: "Clean completed jobs?",
          body: `Permanently removes completed jobs from "${q.name}".`,
          confirmLabel: "Clean",
          confirmColor: "danger",
        })
      )
        action.mutate(() => api.cleanQueue(q.name, { status: "completed", graceMs: 0 }))
    }
    const drain = async (q: QueueSummary) => {
      if (
        await confirm({
          title: "Drain queue?",
          body: `Removes all waiting and delayed jobs from "${q.name}". This cannot be undone.`,
          confirmLabel: "Drain",
          confirmColor: "danger",
        })
      )
        action.mutate(() => api.drainQueue(q.name))
    }

    return [
      {
        id: "name",
        header: "Queue",
        cell: ({ row }) => {
          const q = row.original
          const c = q.counts
          const health = queueHealth(q)
          return (
            <div className="min-w-[200px]">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">{q.name}</span>
                <Chip size="sm" variant="flat" color={health.color}>
                  {health.label}
                </Chip>
              </div>
              <CompositionBar
                className="mt-2 w-48"
                segments={[
                  { label: "Completed", value: c.completed, className: "bg-success" },
                  { label: "Active", value: c.active, className: "bg-secondary" },
                  {
                    label: "Waiting",
                    value: c.waiting + c["waiting-children"],
                    className: "bg-default-300",
                  },
                  { label: "Delayed", value: c.delayed, className: "bg-warning" },
                  { label: "Failed", value: c.failed, className: "bg-danger" },
                ]}
              />
            </div>
          )
        },
      },
      {
        id: "waiting",
        header: "Waiting",
        cell: ({ row }) => <NumCell value={row.original.counts.waiting} />,
      },
      {
        id: "active",
        header: "Active",
        cell: ({ row }) => <NumCell value={row.original.counts.active} color="text-secondary" />,
      },
      {
        id: "delayed",
        header: "Delayed",
        cell: ({ row }) => <NumCell value={row.original.counts.delayed} color="text-warning" />,
      },
      {
        id: "failed",
        header: "Failed",
        cell: ({ row }) => <NumCell value={row.original.counts.failed} color="text-danger" />,
      },
      {
        id: "completed",
        header: "Completed",
        cell: ({ row }) => <NumCell value={row.original.counts.completed} color="text-success" />,
      },
      {
        id: "workers",
        header: "Workers",
        cell: ({ row }) => {
          const q = row.original
          const pending = q.counts.active + q.counts.waiting + q.counts.delayed
          const starved = q.workers === 0 && pending > 0
          return (
            <span
              className={`flex items-center gap-1.5 ${starved ? "text-danger" : "text-foreground-500"}`}
            >
              <CockpitIcon name="workers" width={15} />
              <span className="tabular-nums">{formatNumber(q.workers)}</span>
              {starved && (
                <Tooltip content="No workers connected for pending jobs" size="sm">
                  <span className="text-danger">
                    <CockpitIcon name="alert" width={13} />
                  </span>
                </Tooltip>
              )}
            </span>
          )
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const queue = row.original
          const items: ActionItem[] = [
            {
              key: "open",
              label: "Open queue",
              icon: "chevronRight",
              onAction: () =>
                navigate({ to: "/queues/$queueName", params: { queueName: queue.name } }),
            },
            queue.isPaused
              ? {
                  key: "resume",
                  label: "Resume queue",
                  icon: "resume",
                  hidden: !can("queue:write"),
                  onAction: () => void resume(queue),
                }
              : {
                  key: "pause",
                  label: "Pause queue",
                  icon: "pause",
                  hidden: !can("queue:write"),
                  onAction: () => void pause(queue),
                },
            {
              key: "clean",
              label: "Clean completed",
              icon: "clean",
              hidden: !can("dangerous:write"),
              onAction: () => void clean(queue),
            },
            {
              key: "drain",
              label: "Drain queue",
              icon: "drain",
              color: "danger",
              hidden: !can("dangerous:write"),
              onAction: () => void drain(queue),
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
