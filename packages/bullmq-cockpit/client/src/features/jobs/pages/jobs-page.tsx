import { Button, Input } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { AddJobModal } from "@/features/jobs/components/add-job-modal"
import { PageHeader } from "@/components/ui/page-header"
import { QueuePicker } from "@/components/ui/queue-picker"
import { EmptyState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { usePermission } from "@/lib/providers/config"
import { CockpitIcon } from "@/lib/icons"
import type { JobsSearch } from "@/lib/search"
import { JobStatusTabs } from "@/features/jobs/components/job-status-tabs"
import { JobsTable } from "@/features/jobs/components/jobs-table"

export interface JobsPageProps {
  search: JobsSearch
  onSearchChange: (patch: Partial<JobsSearch>) => void
}

export function JobsPage({ search, onSearchChange }: JobsPageProps) {
  const { data: queues, isLoading: queuesLoading } = useQuery({
    queryKey: ["queues"],
    queryFn: api.queues,
    refetchInterval: 5000,
  })

  const can = usePermission()
  const navigate = useNavigate()
  const queue = search.queue ?? queues?.[0]?.name
  const counts = queues?.find((q) => q.name === queue)?.counts
  const [searchInput, setSearchInput] = useState(search.search ?? "")
  const [addOpen, setAddOpen] = useState(false)

  // Debounce free-text search into the URL.
  useEffect(() => {
    const id = setTimeout(() => {
      const current = search.search ?? ""
      if (current !== searchInput) onSearchChange({ search: searchInput || undefined, page: 1 })
    }, 300)
    return () => clearTimeout(id)
  }, [searchInput, search.search, onSearchChange])

  if (queuesLoading) return <LoadingState label="Loading queues…" />
  if (!queues || queues.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Jobs" icon="jobs" />
        <EmptyState
          icon="queues"
          title="No queues found"
          description="Add a job to a queue to see it here."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Jobs"
        description="Inspect and act on individual jobs"
        icon="jobs"
        actions={
          <div className="flex items-center gap-2.5">
            <QueuePicker
              queues={queues}
              value={queue}
              onChange={(q) => q && onSearchChange({ queue: q, page: 1 })}
              className="w-56"
            />
            {queue && can("job:write") && (
              <Button
                color="primary"
                startContent={<CockpitIcon name="play" width={17} />}
                onPress={() => setAddOpen(true)}
              >
                Add job
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-3 border-b border-default-100 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <JobStatusTabs
            counts={counts}
            value={search.status ?? "all"}
            onChange={(status) =>
              onSearchChange({ status: status === "all" ? undefined : status, page: 1 })
            }
          />
        </div>
        <Input
          aria-label="Search jobs"
          size="md"
          variant="bordered"
          className="sm:w-72"
          placeholder="Search job id or name…"
          value={searchInput}
          onValueChange={setSearchInput}
          startContent={<CockpitIcon name="search" width={17} className="text-foreground-400" />}
          isClearable
          onClear={() => setSearchInput("")}
        />
      </div>

      {queue && (
        <JobsTable
          queue={queue}
          status={search.status}
          search={search.search}
          page={search.page}
          pageSize={search.pageSize}
          onPageChange={(page) => onSearchChange({ page })}
          onPageSizeChange={(pageSize) => onSearchChange({ pageSize, page: 1 })}
          onOpenJob={(job) =>
            navigate({
              to: "/jobs/$queueName/$jobId",
              params: { queueName: job.queueName, jobId: job.id },
            })
          }
        />
      )}

      {queue && <AddJobModal queue={queue} isOpen={addOpen} onClose={() => setAddOpen(false)} />}
    </div>
  )
}
