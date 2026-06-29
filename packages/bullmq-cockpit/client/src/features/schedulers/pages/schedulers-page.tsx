import { Button } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { DataTable } from "@/components/ui/data-table"
import { PageHeader } from "@/components/ui/page-header"
import { QueuePicker } from "@/components/ui/queue-picker"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { CockpitIcon } from "@/lib/icons"
import { AddSchedulerModal } from "@/features/schedulers/components/add-scheduler-modal"
import { useSchedulerColumns } from "@/features/schedulers/config/columns"

export function SchedulersPage() {
  const can = usePermission()
  const confirm = useConfirm()
  const [queue, setQueue] = useState<string | undefined>(undefined)
  const [addOpen, setAddOpen] = useState(false)

  const { data: queues } = useQuery({ queryKey: ["queues"], queryFn: api.queues })

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["schedulers", queue ?? "all"],
    queryFn: () => (queue ? api.queueSchedulers(queue) : api.schedulers()),
    refetchInterval: 8000,
  })

  const action = useCockpitAction({ success: "Scheduler removed", invalidate: [["schedulers"]] })

  const columns = useSchedulerColumns({ can, action, confirm })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Schedulers"
        description="Repeatable & cron jobs that BullMQ enqueues on a schedule"
        icon="schedulers"
        actions={
          <div className="flex items-center gap-2.5">
            <QueuePicker
              queues={queues ?? []}
              value={queue}
              onChange={setQueue}
              allowAll
              className="w-52"
            />
            {can("queue:write") && (
              <Button
                color="primary"
                startContent={<CockpitIcon name="add" width={17} />}
                onPress={() => setAddOpen(true)}
              >
                New scheduler
              </Button>
            )}
          </div>
        }
      />

      {isLoading ? (
        <LoadingState label="Loading schedulers…" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <DataTable
          ariaLabel="Schedulers"
          columns={columns}
          data={data ?? []}
          getRowKey={(s) => `${s.queueName}:${s.id}`}
          emptyContent={
            <EmptyState
              icon="schedulers"
              title="No schedulers"
              description="Create a scheduler to enqueue a job on a cron pattern or fixed interval."
            />
          }
        />
      )}

      <AddSchedulerModal queues={queues ?? []} isOpen={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}
