import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { DataTable } from "@/components/ui/data-table"
import { PageHeader } from "@/components/ui/page-header"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { useFlowColumns } from "@/features/flows/config/columns"
import { api } from "@/lib/api"

export function FlowsPage() {
  const navigate = useNavigate()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["flows"],
    queryFn: api.flows,
    refetchInterval: 6000,
  })

  const columns = useFlowColumns()

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Flows"
        description="Parent jobs waiting on their children (FlowProducer DAGs)"
        icon="flows"
      />
      {isLoading ? (
        <LoadingState label="Loading flows…" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <DataTable
          ariaLabel="Flows"
          columns={columns}
          data={data ?? []}
          getRowKey={(f) => `${f.queueName}:${f.id}`}
          onRowAction={(f) =>
            navigate({
              to: "/jobs/$queueName/$jobId",
              params: { queueName: f.queueName, jobId: f.id },
            })
          }
          emptyContent={
            <EmptyState
              icon="flows"
              title="No active flows"
              description="Parent jobs waiting on children appear here. Enqueue jobs with a FlowProducer to see the tree."
            />
          }
        />
      )}
    </div>
  )
}
