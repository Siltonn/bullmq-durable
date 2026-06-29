/**
 * A reusable, server-paginated jobs table. Both the Jobs page (queue selectable,
 * URL-driven) and the Queue detail page (queue fixed, local state) render it.
 */

import { Button, Checkbox } from "@heroui/react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useEffect, useState } from "react"
import type { JobSummary } from "@shared/dto"
import { DataTable } from "@/components/ui/data-table"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { EmptyState, ErrorState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { CockpitIcon } from "@/lib/icons"
import { useJobsColumns } from "@/features/jobs/config/columns"

export interface JobsTableProps {
  queue: string
  status?: string
  search?: string
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onOpenJob: (job: JobSummary) => void
}

export function JobsTable({
  queue,
  status,
  search,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onOpenJob,
}: JobsTableProps) {
  const can = usePermission()
  const confirm = useConfirm()

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["jobs", queue, { status, search, page, pageSize }],
    queryFn: () => api.jobs(queue, { status, search, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  })

  const action = useCockpitAction({
    success: "Job updated",
    invalidate: [["jobs"], ["queues"], ["overview"]],
  })

  const items = data?.items ?? []
  const canWrite = can("job:write")
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  // Reset the selection whenever the underlying page of jobs changes.
  useEffect(() => setSelected(new Set()), [queue, status, search, page, pageSize])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allSelected = items.length > 0 && items.every((j) => selected.has(j.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((j) => j.id)))

  const bulkAction = (verb: "retry" | "remove") => async () => {
    const ids = [...selected]
    if (
      await confirm({
        title: `${verb === "retry" ? "Retry" : "Remove"} ${ids.length} job(s)?`,
        body:
          verb === "retry"
            ? `Re-queue ${ids.length} selected job(s) on "${queue}".`
            : `Permanently remove ${ids.length} selected job(s) from "${queue}".`,
        confirmLabel: verb === "retry" ? "Retry" : "Remove",
        confirmColor: verb === "retry" ? "primary" : "danger",
      })
    )
      action.mutate(
        () => (verb === "retry" ? api.bulkRetry(queue, ids) : api.bulkRemove(queue, ids)),
        { onSuccess: () => setSelected(new Set()) },
      )
  }

  const columns = useJobsColumns({ queue, can, confirm, action, onOpenJob })

  // The selection column is composed in per-render (it captures the live
  // selection) so the heavier data columns above stay memoized.
  const selectColumn: ColumnDef<JobSummary> = {
    id: "select",
    header: () => (
      <Checkbox
        aria-label="Select all jobs on this page"
        size="sm"
        isSelected={allSelected}
        isIndeterminate={!allSelected && selected.size > 0}
        onValueChange={toggleAll}
      />
    ),
    cell: ({ row }) => (
      <div onPointerDown={(e) => e.stopPropagation()}>
        <Checkbox
          aria-label={`Select job ${row.original.id}`}
          size="sm"
          isSelected={selected.has(row.original.id)}
          onValueChange={() => toggle(row.original.id)}
        />
      </div>
    ),
  }
  const allColumns = canWrite ? [selectColumn, ...columns] : columns

  if (error) return <ErrorState error={error} onRetry={refetch} />

  return (
    <div className="flex flex-col gap-3">
      {selected.size > 0 && canWrite && (
        <div className="flex items-center justify-between rounded-medium border border-secondary/30 bg-secondary/5 px-3 py-2">
          <span className="text-sm font-medium text-foreground-700">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="flat"
              color="warning"
              startContent={<CockpitIcon name="retry" width={14} />}
              onPress={bulkAction("retry")}
            >
              Retry
            </Button>
            <Button
              size="sm"
              variant="flat"
              color="danger"
              startContent={<CockpitIcon name="remove" width={14} />}
              onPress={bulkAction("remove")}
            >
              Remove
            </Button>
            <Button size="sm" variant="light" onPress={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}
      <DataTable
        ariaLabel="Jobs"
        columns={allColumns}
        data={items}
        getRowKey={(job) => job.id}
        isLoading={isLoading || (isFetching && !data)}
        onRowAction={onOpenJob}
        emptyContent={
          <EmptyState icon="jobs" title="No jobs" description="No jobs match the current filter." />
        }
      />
      {data && data.total > 0 && (
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </div>
  )
}
