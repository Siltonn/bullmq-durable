import { Button, Card, CardBody, CardHeader, Chip } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { AddJobModal, JobStatusTabs, JobsTable } from "@/features/jobs"
import { DonutChart, type DonutDatum } from "@/components/charts/donut-chart"
import { MetricCard } from "@/components/ui/metric-card"
import { PageHeader } from "@/components/ui/page-header"
import { ErrorState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { chartPalette } from "@/lib/chart"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { formatNumber } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"

export function QueueDetailPage({ queueName }: { queueName: string }) {
  const can = usePermission()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [addOpen, setAddOpen] = useState(false)

  const {
    data: queue,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["queue", queueName],
    queryFn: () => api.queue(queueName),
    refetchInterval: 5000,
  })

  const action = useCockpitAction({
    success: "Queue updated",
    invalidate: [["queue", queueName], ["queues"], ["overview"]],
  })

  if (isLoading) return <LoadingState label="Loading queue…" />
  if (error || !queue) return <ErrorState error={error} onRetry={refetch} />

  const c = queue.counts
  const total = c.waiting + c.active + c.delayed + c.completed + c.failed + c["waiting-children"]
  const share = (n: number) => (total > 0 ? n / total : 0)
  const palette = chartPalette()
  const donut: DonutDatum[] = [
    { name: "Completed", value: c.completed, color: palette.success },
    { name: "Active", value: c.active, color: palette.secondary },
    { name: "Waiting", value: c.waiting + c["waiting-children"], color: palette.neutral },
    { name: "Delayed", value: c.delayed, color: palette.warning },
    { name: "Failed", value: c.failed, color: palette.danger },
  ]

  const pause = async () => {
    if (
      await confirm({
        title: "Pause queue?",
        body: `Jobs on "${queueName}" won't be processed until resumed.`,
        confirmLabel: "Pause",
        confirmColor: "warning",
      })
    )
      action.mutate(() => api.pauseQueue(queueName))
  }
  const resume = async () => {
    if (
      await confirm({
        title: "Resume queue?",
        body: `Jobs on "${queueName}" will start processing again.`,
        confirmLabel: "Resume",
        confirmColor: "primary",
      })
    )
      action.mutate(() => api.resumeQueue(queueName))
  }
  const clean = async () => {
    if (
      await confirm({
        title: "Clean completed jobs?",
        body: `Permanently removes completed jobs from "${queueName}".`,
        confirmLabel: "Clean",
        confirmColor: "danger",
      })
    )
      action.mutate(() => api.cleanQueue(queueName, { status: "completed", graceMs: 0 }))
  }
  const drain = async () => {
    if (
      await confirm({
        title: "Drain queue?",
        body: `Removes all waiting and delayed jobs from "${queueName}". This cannot be undone.`,
        confirmLabel: "Drain",
        confirmColor: "danger",
      })
    )
      action.mutate(() => api.drainQueue(queueName))
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-1 text-sm text-foreground-400">
        <Link to="/queues" className="transition-colors hover:text-foreground">
          Queues
        </Link>
        <CockpitIcon name="chevronRight" width={14} />
        <span className="text-foreground-600">{queueName}</span>
      </div>

      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {queueName}
            {queue.isPaused && (
              <Chip
                size="md"
                variant="flat"
                color="warning"
                startContent={<CockpitIcon name="paused" width={12} />}
              >
                paused
              </Chip>
            )}
          </span>
        }
        description={`${formatNumber(queue.workers)} worker${queue.workers === 1 ? "" : "s"} connected`}
        icon="queues"
        actions={
          <>
            {can("job:write") && (
              <Button
                size="md"
                color="primary"
                startContent={<CockpitIcon name="play" width={15} />}
                onPress={() => setAddOpen(true)}
              >
                Add job
              </Button>
            )}
            {can("queue:write") &&
              (queue.isPaused ? (
                <Button
                  size="md"
                  variant="flat"
                  color="secondary"
                  startContent={<CockpitIcon name="resume" width={15} />}
                  isLoading={action.isPending}
                  onPress={resume}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  size="md"
                  variant="flat"
                  color="warning"
                  startContent={<CockpitIcon name="pause" width={15} />}
                  isLoading={action.isPending}
                  onPress={pause}
                >
                  Pause
                </Button>
              ))}
            {can("dangerous:write") && (
              <>
                <Button
                  size="md"
                  variant="flat"
                  startContent={<CockpitIcon name="clean" width={15} />}
                  onPress={clean}
                >
                  Clean
                </Button>
                <Button
                  size="md"
                  variant="flat"
                  color="danger"
                  startContent={<CockpitIcon name="drain" width={15} />}
                  onPress={drain}
                >
                  Drain
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card shadow="none" className="glass-card lg:col-span-1">
          <CardHeader className="pb-0">
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground-600">
              <CockpitIcon name="jobs" width={16} className="text-foreground-400" /> Job
              distribution
            </h3>
          </CardHeader>
          <CardBody>
            <DonutChart data={donut} centerLabel="jobs" />
          </CardBody>
        </Card>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-2">
          <MetricCard
            label="Waiting"
            value={formatNumber(c.waiting)}
            icon="waiting"
            share={share(c.waiting)}
          />
          <MetricCard
            label="Active"
            value={formatNumber(c.active)}
            icon="active"
            color="secondary"
            share={share(c.active)}
          />
          <MetricCard
            label="Delayed"
            value={formatNumber(c.delayed)}
            icon="delayed"
            color="warning"
            share={share(c.delayed)}
          />
          <MetricCard
            label="Failed"
            value={formatNumber(c.failed)}
            icon="failed"
            color="danger"
            share={share(c.failed)}
          />
          <MetricCard
            label="Completed"
            value={formatNumber(c.completed)}
            icon="completed"
            color="success"
            share={share(c.completed)}
          />
          <MetricCard
            label="Paused"
            value={formatNumber(c.paused)}
            icon="paused"
            color="secondary"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground-500">Jobs</h2>
        <div className="border-b border-default-100">
          <JobStatusTabs
            counts={queue.counts}
            value={status ?? "all"}
            onChange={(s) => {
              setStatus(s === "all" ? undefined : s)
              setPage(1)
            }}
          />
        </div>
      </div>

      <JobsTable
        queue={queueName}
        status={status}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
        onOpenJob={(job) =>
          navigate({
            to: "/jobs/$queueName/$jobId",
            params: { queueName: job.queueName, jobId: job.id },
          })
        }
      />

      <AddJobModal queue={queueName} isOpen={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}
