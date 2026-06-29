import { Chip } from "@heroui/react"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo } from "react"
import type { JobSummary } from "@shared/dto"
import { ActionMenu, type ActionItem } from "@/components/ui/action-menu"
import { RelativeTime } from "@/components/ui/relative-time"
import { JobStateChip } from "@/components/ui/status-badge"
import { useCockpitAction } from "@/lib/providers/actions"
import { api } from "@/lib/api"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { formatDuration, truncate } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"

export interface UseJobsColumnsOpts {
  queue: string
  can: ReturnType<typeof usePermission>
  confirm: ReturnType<typeof useConfirm>
  action: ReturnType<typeof useCockpitAction>
  onOpenJob: (job: JobSummary) => void
}

export function useJobsColumns(opts: UseJobsColumnsOpts): ColumnDef<JobSummary>[] {
  const { queue, can, confirm, action, onOpenJob } = opts

  return useMemo<ColumnDef<JobSummary>[]>(() => {
    const retry = async (job: JobSummary) => {
      if (
        await confirm({
          title: "Retry job?",
          body: `Re-queue job "${job.id}" on "${queue}".`,
          confirmLabel: "Retry",
          confirmColor: "primary",
        })
      )
        action.mutate(() => api.retryJob(queue, job.id))
    }
    const remove = async (job: JobSummary) => {
      if (
        await confirm({
          title: "Remove job?",
          body: `Permanently remove job "${job.id}" from "${queue}".`,
          confirmLabel: "Remove",
          confirmColor: "danger",
        })
      )
        action.mutate(() => api.removeJob(queue, job.id))
    }
    const promote = async (job: JobSummary) => {
      if (
        await confirm({
          title: "Promote job?",
          body: `Move job "${job.id}" to the front of "${queue}" so it runs as soon as a worker is free.`,
          confirmLabel: "Promote",
          confirmColor: "primary",
        })
      )
        action.mutate(() => api.promoteJob(queue, job.id))
    }
    const duplicate = async (job: JobSummary) => {
      if (
        await confirm({
          title: "Duplicate job?",
          body: `Enqueue a copy of job "${job.id}" (a fresh id, same name & data) on "${queue}".`,
          confirmLabel: "Duplicate",
          confirmColor: "primary",
        })
      )
        action.mutate(() => api.duplicateJob(queue, job.id))
    }

    return [
      {
        id: "id",
        header: "Job",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[13px] text-foreground-700">
              {truncate(row.original.id, 28)}
            </span>
            <span className="text-[13px] text-foreground-400">{row.original.name}</span>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <JobStateChip state={row.original.state} />,
      },
      {
        id: "attempts",
        header: "Attempts",
        cell: ({ row }) => (
          <span className="tabular-nums text-foreground-500">
            {row.original.attemptsMade}
            {row.original.maxAttempts ? `/${row.original.maxAttempts}` : ""}
          </span>
        ),
      },
      {
        id: "created",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-foreground-500">
            <RelativeTime value={row.original.timestamp} />
          </span>
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
        id: "durable",
        header: "Durable",
        cell: ({ row }) =>
          row.original.durable ? (
            <Chip
              size="sm"
              variant="flat"
              color={row.original.durable.isResume ? "secondary" : "default"}
              startContent={<CockpitIcon name="durable" width={12} />}
            >
              {row.original.durable.isResume ? "resume" : "durable"}
            </Chip>
          ) : (
            <span className="text-foreground-300">—</span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const job = row.original
          const items: ActionItem[] = [
            {
              key: "open",
              label: "Open job",
              icon: "chevronRight",
              onAction: () => onOpenJob(job),
            },
            {
              key: "retry",
              label: "Retry",
              icon: "retry",
              hidden: !can("job:write") || (job.state !== "failed" && job.state !== "completed"),
              onAction: () => void retry(job),
            },
            {
              key: "promote",
              label: "Promote",
              icon: "promote",
              hidden: !can("job:write") || job.state !== "delayed",
              onAction: () => void promote(job),
            },
            {
              key: "duplicate",
              label: "Duplicate",
              icon: "duplicate",
              hidden: !can("job:write"),
              onAction: () => void duplicate(job),
            },
            {
              key: "remove",
              label: "Remove",
              icon: "remove",
              color: "danger",
              hidden: !can("job:write"),
              onAction: () => void remove(job),
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
  }, [can, action, confirm, onOpenJob, queue])
}
