import { Button } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { DataTable } from "@/components/ui/data-table"
import { PageHeader } from "@/components/ui/page-header"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { CockpitIcon } from "@/lib/icons"
import { useQueueColumns } from "@/features/queues/config/columns"

export function QueuesPage() {
  const navigate = useNavigate()
  const can = usePermission()
  const confirm = useConfirm()

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["queues"],
    queryFn: api.queues,
    refetchInterval: 5000,
  })

  const action = useCockpitAction({
    success: "Queue updated",
    invalidate: [["queues"], ["overview"]],
  })

  const columns = useQueueColumns({ navigate, can, action, confirm })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Queues"
        description="Every BullMQ queue this cockpit can see"
        icon="queues"
        actions={
          <Button
            variant="flat"
            startContent={<CockpitIcon name="refresh" width={17} />}
            onPress={() => refetch()}
            isLoading={isFetching}
          >
            Refresh
          </Button>
        }
      />

      {isLoading ? (
        <LoadingState label="Loading queues…" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <DataTable
          ariaLabel="Queues"
          columns={columns}
          data={data ?? []}
          getRowKey={(q) => q.name}
          onRowAction={(q) => navigate({ to: "/queues/$queueName", params: { queueName: q.name } })}
          emptyContent={
            <EmptyState
              icon="queues"
              title="No queues found"
              description="Add a job to a queue, or pass an explicit `queues` list when mounting the cockpit."
            />
          }
        />
      )}
    </div>
  )
}
