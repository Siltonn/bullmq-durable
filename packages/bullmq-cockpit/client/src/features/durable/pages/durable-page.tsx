import { Input, Select, SelectItem, Switch } from "@heroui/react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { STATUS_OPTIONS } from "@/features/durable/config/constants"
import { useDurableColumns } from "@/features/durable/config/columns"
import { DataTable } from "@/components/ui/data-table"
import { PageHeader } from "@/components/ui/page-header"
import { QueuePicker } from "@/components/ui/queue-picker"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { EmptyState, ErrorState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { CockpitIcon } from "@/lib/icons"
import type { DurableSearch } from "@/lib/search"

export interface DurablePageProps {
  search: DurableSearch
  onSearchChange: (patch: Partial<DurableSearch>) => void
}

export function DurablePage({ search, onSearchChange }: DurablePageProps) {
  const navigate = useNavigate()
  const can = usePermission()
  const confirm = useConfirm()
  const [searchInput, setSearchInput] = useState(search.search ?? "")

  const { data: queues } = useQuery({ queryKey: ["queues"], queryFn: api.queues })

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["durable", search],
    queryFn: () =>
      api.durableInstances({
        status: search.status,
        queue: search.queue,
        search: search.search,
        stuckOnly: search.stuckOnly,
        sort: search.sort,
        order: search.order,
        page: search.page,
        pageSize: search.pageSize,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 4000,
  })

  const action = useCockpitAction({
    success: "Instance updated",
    invalidate: [["durable"], ["overview"], ["health"]],
  })

  useEffect(() => {
    const id = setTimeout(() => {
      const current = search.search ?? ""
      if (current !== searchInput) onSearchChange({ search: searchInput || undefined, page: 1 })
    }, 300)
    return () => clearTimeout(id)
  }, [searchInput, search.search, onSearchChange])

  const columns = useDurableColumns({ navigate, can, action, confirm })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Durable instances"
        description="bullmq-durable execution state: steps, sleeps, retries, and resumes"
        icon="durable"
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <Select
          label="Status"
          labelPlacement="outside"
          size="md"
          variant="bordered"
          className="sm:max-w-44"
          selectedKeys={[search.status ?? "all"]}
          onSelectionChange={(keys) => {
            const value = String(Array.from(keys)[0] ?? "all")
            onSearchChange({ status: value === "all" ? undefined : value, page: 1 })
          }}
        >
          {STATUS_OPTIONS.map(([value, label]) => (
            <SelectItem key={value}>{label}</SelectItem>
          ))}
        </Select>

        <QueuePicker
          label="Queue"
          allowAll
          queues={queues ?? []}
          value={search.queue}
          onChange={(q) => onSearchChange({ queue: q, page: 1 })}
          className="sm:max-w-52"
        />

        <Input
          label="Search"
          labelPlacement="outside"
          size="md"
          variant="bordered"
          className="sm:max-w-64"
          placeholder="Instance or business id…"
          value={searchInput}
          onValueChange={setSearchInput}
          startContent={<CockpitIcon name="search" width={17} className="text-foreground-400" />}
          isClearable
          onClear={() => setSearchInput("")}
        />

        <div className="flex items-center pb-2">
          <Switch
            size="sm"
            isSelected={Boolean(search.stuckOnly)}
            onValueChange={(value) => onSearchChange({ stuckOnly: value || undefined, page: 1 })}
          >
            <span className="text-[15px] text-foreground-500">Stuck only</span>
          </Switch>
        </div>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <>
          {data?.truncated && (
            <p className="text-xs text-foreground-400">
              Showing the most recent instances — deeper pages are capped for performance.
            </p>
          )}
          <DataTable
            ariaLabel="Durable instances"
            columns={columns}
            data={data?.items ?? []}
            getRowKey={(inst) => inst.id}
            isLoading={isLoading || (isFetching && !data)}
            onRowAction={(inst) =>
              navigate({ to: "/durable/$instanceId", params: { instanceId: inst.id } })
            }
            emptyContent={
              <EmptyState
                icon="durable"
                title="No durable instances"
                description="Run a DurableWorker to populate this view."
              />
            }
          />
          {data && data.total > 0 && (
            <PaginationBar
              page={search.page}
              pageSize={search.pageSize}
              total={data.total}
              onPageChange={(page) => onSearchChange({ page })}
              onPageSizeChange={(pageSize) => onSearchChange({ pageSize, page: 1 })}
            />
          )}
        </>
      )}
    </div>
  )
}
