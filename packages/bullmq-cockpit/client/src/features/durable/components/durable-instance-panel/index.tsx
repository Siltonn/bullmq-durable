/**
 * The full durable instance inspector, as a self-contained panel.
 *
 * Reused in two places so both sides stay rich:
 *  - the standalone `/durable/{id}` page (with a breadcrumb above it)
 *  - embedded in the job detail page's "Durable" tab when a job is durable
 *
 * It fetches its own data and degrades gracefully: a deleted/missing instance
 * shows a friendly empty state rather than an error.
 */

import { Button, Card, CardBody, CardHeader, Tab, Tabs } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useCockpitAction } from "@/lib/providers/actions"
import { api, errorStatus } from "@/lib/api"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { CockpitIcon } from "@/lib/icons"
import { JsonViewer } from "@/components/ui/json-viewer"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { DurableWaterfall } from "@/features/durable/components/durable-waterfall"
import { EventsView, LogsView } from "./event-log"
import { InstanceHeader } from "./summary"
import { StepDetail } from "./step-detail"

export interface DurableInstancePanelProps {
  instanceId: string
  /** Show a "View job" link in the actions (hidden when already on a job page). */
  showJobLink?: boolean
  /** Called after the durable state is deleted (e.g. to navigate away). */
  onDeleted?: () => void
}

export function DurableInstancePanel({
  instanceId,
  showJobLink = true,
  onDeleted,
}: DurableInstancePanelProps) {
  const can = usePermission()
  const confirm = useConfirm()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["durableInstance", instanceId],
    queryFn: () => api.durableInstance(instanceId),
    refetchInterval: 3000,
    retry: (count, err) => errorStatus(err) !== 404 && count < 1,
  })
  const { data: logs } = useQuery({
    queryKey: ["durableLogs", instanceId],
    queryFn: () => api.durableLogs(instanceId),
    refetchInterval: 5000,
    retry: false,
  })
  const { data: events } = useQuery({
    queryKey: ["durableEvents", instanceId],
    queryFn: () => api.durableEvents(instanceId),
    refetchInterval: 5000,
    retry: false,
  })

  const action = useCockpitAction({
    success: "Instance updated",
    invalidate: [
      ["durableInstance", instanceId],
      ["durableLogs", instanceId],
      ["durableEvents", instanceId],
      ["durable"],
      ["overview"],
      ["health"],
      ["job"],
    ],
  })

  if (isLoading) return <LoadingState label="Loading instance…" />
  if (errorStatus(error) === 404) {
    return (
      <Card shadow="none" className="glass-card">
        <CardBody>
          <EmptyState
            icon="durable"
            title="No durable state"
            description="This instance has no durable state (it may have been deleted, or the job never ran through a DurableWorker)."
          />
        </CardBody>
      </Card>
    )
  }
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />

  const steps = data.steps
  const yielded = data.status === "yielded"
  const running = data.status === "running"

  const doResume = async () => {
    if (
      await confirm({
        title: "Resume now?",
        body: "Enqueue a zero-delay resume tick for this instance.",
        confirmLabel: "Resume",
        confirmColor: "primary",
      })
    )
      action.mutate(() => api.durableResume(instanceId))
  }
  const doRetry = async () => {
    if (
      await confirm({
        title: "Retry instance?",
        body: "Re-runs the failed step. Completed steps stay cached.",
        confirmLabel: "Retry",
        confirmColor: "warning",
      })
    )
      action.mutate(() => api.durableRetry(instanceId))
  }
  const doRetryCompensation = async () => {
    if (
      await confirm({
        title: "Retry compensation?",
        body: "Re-runs the compensations that failed. Already-rolled-back steps stay cached.",
        confirmLabel: "Retry compensation",
        confirmColor: "warning",
      })
    )
      action.mutate(() => api.durableRetryCompensation(instanceId))
  }
  const doCancel = async () => {
    if (
      await confirm({
        title: "Cancel instance?",
        body: "Marks the instance cancelled and stops it at the next step.",
        confirmLabel: "Cancel instance",
        confirmColor: "warning",
      })
    )
      action.mutate(() => api.durableCancel(instanceId))
  }
  const doDelete = async () => {
    if (
      await confirm({
        title: "Delete durable state?",
        body: `Deletes the durable state for "${instanceId}" (steps, logs, instance). It does NOT touch your business database or BullMQ jobs.`,
        confirmLabel: "Delete state",
        confirmColor: "danger",
      })
    )
      action.mutate(() => api.durableDelete(instanceId), { onSuccess: onDeleted })
  }

  const actions = (
    <>
      {showJobLink && (
        <Link
          to="/jobs/$queueName/$jobId"
          params={{ queueName: data.queueName, jobId: data.originalJobId }}
        >
          <Button size="md" variant="flat" startContent={<CockpitIcon name="jobs" width={15} />}>
            View job
          </Button>
        </Link>
      )}
      {can("durable:resume") && (yielded || running) && (
        <Button
          size="md"
          color="secondary"
          variant="flat"
          startContent={<CockpitIcon name="resume" width={15} />}
          isLoading={action.isPending}
          onPress={doResume}
        >
          Resume
        </Button>
      )}
      {can("durable:retry") && data.status === "failed" && (
        <Button
          size="md"
          color="warning"
          variant="flat"
          startContent={<CockpitIcon name="retry" width={15} />}
          isLoading={action.isPending}
          onPress={doRetry}
        >
          Retry
        </Button>
      )}
      {can("durable:retry") && data.status === "compensation_failed" && (
        <Button
          size="md"
          color="danger"
          variant="flat"
          startContent={<CockpitIcon name="rollback" width={15} />}
          isLoading={action.isPending}
          onPress={doRetryCompensation}
        >
          Retry compensation
        </Button>
      )}
      {can("durable:cancel") && (yielded || running) && (
        <Button
          size="md"
          variant="flat"
          startContent={<CockpitIcon name="cancel" width={15} />}
          isLoading={action.isPending}
          onPress={doCancel}
        >
          Cancel
        </Button>
      )}
      {can("durable:delete") && (
        <Button
          size="md"
          color="danger"
          variant="flat"
          startContent={<CockpitIcon name="remove" width={15} />}
          onPress={doDelete}
        >
          Delete state
        </Button>
      )}
    </>
  )

  const compFailed = data.status === "compensation_failed" ? (data.compensation?.failed ?? []) : []

  return (
    <div className="flex flex-col gap-5">
      <InstanceHeader instance={data} actions={actions} />

      {data.status === "compensation_failed" && (
        <div className="rounded-medium border border-danger-200 bg-danger-50/60 p-3 text-sm dark:bg-danger-50/10">
          <div className="flex items-center gap-2 font-semibold text-danger">
            <CockpitIcon name="compensationFailed" width={16} />
            Compensation failed — manual intervention needed
          </div>
          <div className="mt-1 text-foreground-600">
            {compFailed.length} of {(data.compensation?.rolledBack.length ?? 0) + compFailed.length}{" "}
            compensation(s) could not be completed. Side effects may be partially un-done. Use
            “Retry compensation” once the cause is fixed.
          </div>
          {compFailed.length > 0 && (
            <ul className="mt-2 space-y-1">
              {compFailed.map((c) => (
                <li key={c.key} className="text-xs text-danger">
                  <span className="font-mono">{c.key}</span>
                  {c.error?.message ? ` — ${c.error.message}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Card shadow="none" className="glass-card">
        <CardHeader className="flex items-center justify-between pb-0">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-600">
            <CockpitIcon name="durable" width={16} className="text-foreground-400" /> Execution flow
          </h2>
          <span className="text-xs text-foreground-400">click a step for detail</span>
        </CardHeader>
        <CardBody>
          {steps.length === 0 ? (
            <EmptyState
              icon="steps"
              title="No steps yet"
              description="Steps appear as the processor runs."
            />
          ) : (
            <DurableWaterfall
              instance={data}
              events={events}
              renderStepDetail={(step) => <StepDetail step={step} />}
            />
          )}
        </CardBody>
      </Card>

      <Card shadow="none" className="glass-card">
        <CardBody>
          <Tabs aria-label="Instance detail" variant="underlined" classNames={{ panel: "pt-4" }}>
            <Tab key="input" title="Input">
              <JsonViewer value={data.input} emptyLabel="No input" />
            </Tab>
            <Tab key="output" title="Output">
              {data.error ? (
                <div className="rounded-medium border border-danger-200 bg-danger-50/50 p-3 text-sm text-danger dark:bg-danger-50/10">
                  <div className="font-medium">{data.error.name}</div>
                  <div className="mt-0.5">{data.error.message}</div>
                </div>
              ) : (
                <JsonViewer value={data.output} emptyLabel="No output yet" />
              )}
            </Tab>
            <Tab key="logs" title="Logs">
              <LogsView logs={logs} />
            </Tab>
            <Tab key="events" title="Events">
              <EventsView events={events} />
            </Tab>
          </Tabs>
        </CardBody>
      </Card>
    </div>
  )
}
