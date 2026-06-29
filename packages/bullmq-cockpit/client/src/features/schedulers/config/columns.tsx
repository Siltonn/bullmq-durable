import { Chip } from "@heroui/react"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo } from "react"
import type { SchedulerSummary } from "@shared/dto"
import { ActionMenu, type ActionItem } from "@/components/ui/action-menu"
import { Countdown } from "@/components/ui/relative-time"
import { api } from "@/lib/api"
import type { useCockpitAction } from "@/lib/providers/actions"
import type { usePermission } from "@/lib/providers/config"
import type { useConfirm } from "@/lib/providers/confirm"
import { formatDuration } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"

export interface UseSchedulerColumnsOpts {
  can: ReturnType<typeof usePermission>
  action: ReturnType<typeof useCockpitAction>
  confirm: ReturnType<typeof useConfirm>
}

export function useSchedulerColumns(opts: UseSchedulerColumnsOpts): ColumnDef<SchedulerSummary>[] {
  const { can, action, confirm } = opts

  return useMemo<ColumnDef<SchedulerSummary>[]>(() => {
    const remove = async (s: SchedulerSummary) => {
      if (
        await confirm({
          title: "Remove scheduler?",
          body: `Stops the scheduler "${s.id}" on "${s.queueName}". Already-queued runs are not removed.`,
          confirmLabel: "Remove",
          confirmColor: "danger",
        })
      )
        action.mutate(() => api.removeScheduler(s.queueName, s.id))
    }

    return [
      {
        id: "id",
        header: "Scheduler",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">{row.original.id}</span>
            <span className="text-[13px] text-foreground-400">job: {row.original.name}</span>
          </div>
        ),
      },
      {
        id: "queue",
        header: "Queue",
        cell: ({ row }) => <span className="text-foreground-600">{row.original.queueName}</span>,
      },
      {
        id: "schedule",
        header: "Schedule",
        cell: ({ row }) =>
          row.original.pattern ? (
            <Chip
              size="sm"
              variant="flat"
              startContent={<CockpitIcon name="schedulers" width={13} />}
            >
              <span className="font-mono text-[12px]">{row.original.pattern}</span>
            </Chip>
          ) : row.original.every ? (
            <Chip
              size="sm"
              variant="flat"
              color="secondary"
              startContent={<CockpitIcon name="timer" width={13} />}
            >
              every {formatDuration(row.original.every)}
            </Chip>
          ) : (
            <span className="text-foreground-300">—</span>
          ),
      },
      {
        id: "next",
        header: "Next run",
        cell: ({ row }) =>
          row.original.next ? (
            <Countdown target={row.original.next} />
          ) : (
            <span className="text-foreground-300">—</span>
          ),
      },
      {
        id: "tz",
        header: "Timezone",
        cell: ({ row }) => <span className="text-foreground-500">{row.original.tz ?? "—"}</span>,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const items: ActionItem[] = [
            {
              key: "remove",
              label: "Remove scheduler",
              icon: "remove",
              color: "danger",
              hidden: !can("queue:write"),
              onAction: () => void remove(row.original),
            },
          ]
          return (
            <div className="flex justify-end">
              <ActionMenu items={items} />
            </div>
          )
        },
      },
    ]
  }, [can, action, confirm])
}
