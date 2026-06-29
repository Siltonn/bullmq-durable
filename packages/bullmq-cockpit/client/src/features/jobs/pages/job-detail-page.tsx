import { Button, Card, CardBody, CardHeader, Chip, Divider, Tab, Tabs } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { JobDetail, JobLogs } from "@shared/dto"
import { CopyButton } from "@/components/ui/copy-button"
import { JsonViewer } from "@/components/ui/json-viewer"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { JobStateChip } from "@/components/ui/status-badge"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { formatDateTime, formatDuration } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import { JobFlowCard } from "@/features/flows"
import { DurableInstancePanel } from "@/features/durable"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-foreground-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground-700">{children}</dd>
    </div>
  )
}

function MetaGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground-500">
        {label}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5">{children}</dl>
    </div>
  )
}

function LogsView({ logs }: { logs?: JobLogs }) {
  if (!logs || logs.logs.length === 0) {
    return (
      <EmptyState icon="logs" title="No logs" description="This job has not written any logs." />
    )
  }
  return (
    <ol className="overflow-hidden rounded-medium border border-default-200 font-mono text-xs">
      {logs.logs.map((line, index) => (
        <li
          key={index}
          className="flex gap-3 border-b border-default-100 px-3 py-2 last:border-b-0 odd:bg-default-50/50"
        >
          <span className="select-none text-foreground-300">{index + 1}</span>
          <span className="whitespace-pre-wrap break-all text-foreground-600">{line}</span>
        </li>
      ))}
    </ol>
  )
}

/** Grouped job metadata — timeline on the left, execution facts on the right.
 *  State lives in the header chip and queue in the breadcrumb, so neither is
 *  repeated here. */
function JobMeta({ job }: { job: JobDetail }) {
  return (
    <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      <MetaGroup label="Timeline">
        <Field label="Created">{formatDateTime(job.timestamp)}</Field>
        <Field label="Duration">{formatDuration(job.durationMs)}</Field>
        <Field label="Processed">{job.processedOn ? formatDateTime(job.processedOn) : "—"}</Field>
        <Field label="Finished">{job.finishedOn ? formatDateTime(job.finishedOn) : "—"}</Field>
      </MetaGroup>
      <MetaGroup label="Execution">
        <Field label="Attempts">
          {job.attemptsMade}
          {job.maxAttempts ? ` / ${job.maxAttempts}` : ""}
        </Field>
        <Field label="Priority">{job.priority ?? "—"}</Field>
        <Field label="Delay">{job.delay ? formatDuration(job.delay) : "—"}</Field>
      </MetaGroup>
    </div>
  )
}

export function JobDetailPage({ queueName, jobId }: { queueName: string; jobId: string }) {
  const can = usePermission()
  const confirm = useConfirm()
  const navigate = useNavigate()

  const {
    data: job,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["job", queueName, jobId],
    queryFn: () => api.job(queueName, jobId),
    refetchInterval: 5000,
  })
  const { data: logs } = useQuery({
    queryKey: ["jobLogs", queueName, jobId],
    queryFn: () => api.jobLogs(queueName, jobId),
    refetchInterval: 8000,
  })

  const action = useCockpitAction({
    success: "Job updated",
    invalidate: [["job", queueName, jobId], ["jobs"], ["queues"], ["overview"]],
  })

  if (isLoading) return <LoadingState label="Loading job…" />
  if (error || !job) return <ErrorState error={error} onRetry={refetch} />

  const retry = async () => {
    if (
      await confirm({
        title: "Retry job?",
        body: `Re-queue job "${job.id}" on "${queueName}".`,
        confirmLabel: "Retry",
        confirmColor: "primary",
      })
    )
      action.mutate(() => api.retryJob(queueName, job.id))
  }
  const remove = async () => {
    if (
      await confirm({
        title: "Remove job?",
        body: `Permanently remove job "${job.id}" from "${queueName}".`,
        confirmLabel: "Remove",
        confirmColor: "danger",
      })
    )
      action.mutate(() => api.removeJob(queueName, job.id), {
        onSuccess: () =>
          navigate({ to: "/jobs", search: { queue: queueName, page: 1, pageSize: 50 } }),
      })
  }
  const promote = async () => {
    if (
      await confirm({
        title: "Promote job?",
        body: `Move job "${job.id}" to the front of "${queueName}" so it runs as soon as a worker is free.`,
        confirmLabel: "Promote",
        confirmColor: "primary",
      })
    )
      action.mutate(() => api.promoteJob(queueName, job.id))
  }
  const duplicate = async () => {
    if (
      await confirm({
        title: "Duplicate job?",
        body: `Enqueue a copy of job "${job.id}" (a fresh id, same name & data) on "${queueName}".`,
        confirmLabel: "Duplicate",
        confirmColor: "primary",
      })
    )
      action.mutate(() => api.duplicateJob(queueName, job.id))
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-1 text-sm text-foreground-400">
        <Link
          to="/jobs"
          search={{ queue: queueName, page: 1, pageSize: 50 }}
          className="transition-colors hover:text-foreground"
        >
          Jobs
        </Link>
        <CockpitIcon name="chevronRight" width={14} />
        <Link
          to="/queues/$queueName"
          params={{ queueName }}
          className="transition-colors hover:text-foreground"
        >
          {queueName}
        </Link>
        <CockpitIcon name="chevronRight" width={14} />
        <span className="truncate font-mono text-xs text-foreground-600">{job.id}</span>
      </div>

      <Card shadow="none" className="glass-card">
        <CardBody className="gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <JobStateChip state={job.state} size="md" />
                {job.durable && (
                  <Chip
                    size="md"
                    variant="flat"
                    color={job.durable.isResume ? "secondary" : "primary"}
                    startContent={<CockpitIcon name="durable" width={12} />}
                  >
                    {job.durable.isResume ? "durable · resume tick" : "durable"}
                  </Chip>
                )}
              </div>
              <div>
                <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                  {job.name}
                </h1>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="truncate font-mono text-xs text-foreground-400">{job.id}</span>
                  <CopyButton value={job.id} label="Copy job id" />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(job.state === "failed" || job.state === "completed") && can("job:write") && (
                <Button
                  size="md"
                  color="warning"
                  variant="flat"
                  startContent={<CockpitIcon name="retry" width={15} />}
                  isLoading={action.isPending}
                  onPress={retry}
                >
                  Retry
                </Button>
              )}
              {job.state === "delayed" && can("job:write") && (
                <Button
                  size="md"
                  variant="flat"
                  startContent={<CockpitIcon name="promote" width={15} />}
                  isLoading={action.isPending}
                  onPress={promote}
                >
                  Promote
                </Button>
              )}
              {can("job:write") && (
                <Button
                  size="md"
                  variant="flat"
                  startContent={<CockpitIcon name="duplicate" width={15} />}
                  onPress={duplicate}
                >
                  Duplicate
                </Button>
              )}
              {can("job:write") && (
                <Button
                  size="md"
                  color="danger"
                  variant="flat"
                  startContent={<CockpitIcon name="remove" width={15} />}
                  onPress={remove}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
          <Divider />
          <JobMeta job={job} />
        </CardBody>
      </Card>

      <Card shadow="none" className="glass-card">
        <CardHeader className="pb-0">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-600">
            <CockpitIcon name="data" width={16} className="text-foreground-400" /> Payload & logs
          </h2>
        </CardHeader>
        <CardBody>
          <Tabs aria-label="Job detail" variant="underlined" classNames={{ panel: "pt-4" }}>
            <Tab key="data" title="Data">
              <JsonViewer value={job.data} />
            </Tab>
            <Tab key="return" title="Return value">
              <JsonViewer value={job.returnValue} emptyLabel="No return value" />
            </Tab>
            <Tab key="logs" title="Logs">
              <LogsView logs={logs} />
            </Tab>
            {(job.failedReason || (job.stacktrace && job.stacktrace.length > 0)) && (
              <Tab key="error" title="Error">
                <div className="space-y-3">
                  {job.failedReason && (
                    <div className="rounded-medium border border-danger-200 bg-danger-50/50 p-3 text-sm text-danger dark:bg-danger-50/10">
                      {job.failedReason}
                    </div>
                  )}
                  {job.stacktrace && job.stacktrace.length > 0 && (
                    <JsonViewer value={job.stacktrace} />
                  )}
                </div>
              </Tab>
            )}
            <Tab key="raw" title="Raw">
              <JsonViewer value={job} maxHeight={460} />
            </Tab>
          </Tabs>
        </CardBody>
      </Card>

      <JobFlowCard queueName={queueName} jobId={jobId} />

      {job.durable && (
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-500">
            <CockpitIcon name="durable" width={16} className="text-primary" /> Durable execution
            {job.durable.isResume && (
              <span className="text-xs font-normal text-foreground-400">
                (this job is a resume tick)
              </span>
            )}
          </h2>
          <DurableInstancePanel instanceId={job.durable.instanceId} showJobLink={false} />
        </section>
      )}
    </div>
  )
}
