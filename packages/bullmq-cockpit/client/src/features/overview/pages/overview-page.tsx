import { Button } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { QueueSummary } from "@shared/dto"
import { PageHeader } from "@/components/ui/page-header"
import { QueueCard } from "@/features/overview/components/queue-card"
import { ErrorState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { formatDuration, formatNumber } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import type { ChipColor } from "@/lib/status"
import { DurableSummary } from "@/features/overview/components/durable-summary"
import { HealthStrip, type Attention } from "@/features/overview/components/health-strip"
import { SectionHeader } from "@/features/overview/components/section-header"
import { SignalStat } from "@/features/overview/components/signal-stat"

/** Worst / busiest queues first. */
function queueScore(q: QueueSummary): number {
  const pending = q.counts.waiting + q.counts.delayed + q.counts["waiting-children"]
  return (
    (q.workers === 0 && pending > 0 ? 100_000 : 0) +
    q.counts.failed * 100 +
    q.counts.active * 10 +
    pending
  )
}

const fmtRate = (n: number) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1))

export function OverviewPage() {
  const navigate = useNavigate()
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 5000,
  })
  const { data: queues } = useQuery({
    queryKey: ["queues"],
    queryFn: api.queues,
    refetchInterval: 5000,
  })
  const { data: signals } = useQuery({
    queryKey: ["signals"],
    queryFn: () => api.signals(60),
    refetchInterval: 8000,
  })
  const { data: alerts } = useQuery({
    queryKey: ["alerts"],
    queryFn: api.alerts,
    refetchInterval: 8000,
  })

  const goJobs = (status?: string) =>
    navigate({ to: "/jobs", search: { status, page: 1, pageSize: 50 } })
  const goDurable = (status?: string) =>
    navigate({ to: "/durable", search: { status, page: 1, pageSize: 50 } })

  if (isLoading) return <LoadingState label="Loading overview…" />
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />

  const { jobs, durable } = data
  const totalJobs =
    jobs.waiting +
    jobs.active +
    jobs.delayed +
    jobs.completed +
    jobs.failed +
    jobs["waiting-children"]

  const firing = alerts?.firing ?? 0
  const stuck = durable?.stuck ?? 0
  const noWorkers = signals?.queuesWithoutWorkers ?? 0

  // Only surface problems that actually exist; the tone escalates with severity.
  const allAttention: Attention[] = [
    {
      icon: "failed",
      count: jobs.failed,
      label: "failed",
      color: "danger",
      onClick: () => goJobs("failed"),
    },
    {
      icon: "alerts",
      count: firing,
      label: firing === 1 ? "alert" : "alerts",
      color: "danger",
      onClick: () => navigate({ to: "/alerts" }),
    },
    {
      icon: "stuck",
      count: stuck,
      label: "stuck",
      color: "warning",
      onClick: () => navigate({ to: "/health" }),
    },
    {
      icon: "workers",
      count: noWorkers,
      label: noWorkers === 1 ? "idle queue" : "idle queues",
      color: "warning",
      onClick: () => navigate({ to: "/queues" }),
    },
  ]
  const attention = allAttention.filter((a) => a.count > 0)

  const critical = jobs.failed > 0 || firing > 0
  const warn = stuck > 0 || noWorkers > 0
  const tone: ChipColor = critical ? "danger" : warn ? "warning" : "success"
  const verdict = critical ? "Needs attention" : warn ? "Minor issues" : "All systems healthy"

  const s = signals
  const sortedQueues = [...(queues ?? [])].sort((a, b) => queueScore(b) - queueScore(a))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description={`${formatNumber(data.queues)} queue${data.queues === 1 ? "" : "s"} · ${formatNumber(totalJobs)} jobs`}
        icon="dashboard"
        actions={
          <Button
            size="md"
            variant="flat"
            startContent={<CockpitIcon name="refresh" width={15} />}
            onPress={() => refetch()}
            isLoading={isFetching}
          >
            Refresh
          </Button>
        }
      />

      <HealthStrip tone={tone} verdict={verdict} items={attention} />

      {/* Golden signals — recent pulse of the system. */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          icon="metrics"
          title="Signals"
          action={
            <Button size="sm" variant="light" onPress={() => navigate({ to: "/metrics" })}>
              {s ? `last ${s.windowMinutes}m` : "Metrics"}
            </Button>
          }
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SignalStat
            label="Throughput"
            value={s ? `${fmtRate(s.throughputPerMin)}/min` : "—"}
            hint={
              s ? `${formatNumber(s.completed)} done · ${formatNumber(s.failed)} failed` : undefined
            }
            onClick={() => navigate({ to: "/metrics" })}
          />
          <SignalStat
            label="Error rate"
            value={s ? `${(s.errorRate * 100).toFixed(1)}%` : "—"}
            tone={
              !s
                ? "default"
                : s.errorRate > 0.1
                  ? "danger"
                  : s.errorRate > 0
                    ? "warning"
                    : "success"
            }
            hint={
              s
                ? `${formatNumber(s.failed)} of ${formatNumber(s.completed + s.failed)} jobs`
                : undefined
            }
            onClick={() => goJobs("failed")}
          />
          <SignalStat
            label="Queue wait"
            value={s ? (s.maxWaitMs > 0 ? formatDuration(s.maxWaitMs) : "0ms") : "—"}
            tone={
              !s
                ? "default"
                : s.maxWaitMs > 300_000
                  ? "danger"
                  : s.maxWaitMs > 60_000
                    ? "warning"
                    : "success"
            }
            hint="oldest waiting job"
            onClick={() => navigate({ to: "/queues" })}
          />
          <SignalStat
            label="Backlog"
            value={s ? formatNumber(s.backlog) : formatNumber(jobs.waiting + jobs.delayed)}
            tone={!s ? "default" : noWorkers > 0 || s.backlog > 100 ? "warning" : "default"}
            hint={noWorkers > 0 ? "no workers running" : "pending across queues"}
            onClick={() => navigate({ to: "/queues" })}
          />
        </div>
      </section>

      {/* Queues — the workhorse view. */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          icon="queues"
          title="Queues"
          action={
            <Button size="sm" variant="light" onPress={() => navigate({ to: "/queues" })}>
              All queues
            </Button>
          }
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sortedQueues.map((q) => (
            <QueueCard
              key={q.name}
              queue={q}
              onOpen={() => navigate({ to: "/queues/$queueName", params: { queueName: q.name } })}
              onStatus={(status) =>
                navigate({ to: "/jobs", search: { queue: q.name, status, page: 1, pageSize: 50 } })
              }
            />
          ))}
        </div>
      </section>

      {/* Durable — the differentiator, in one compact card. */}
      {durable && (
        <section className="flex flex-col gap-3">
          <SectionHeader icon="durable" title="Durable" />
          <DurableSummary
            d={durable}
            onStatus={(status) => goDurable(status)}
            onAll={() => goDurable()}
          />
        </section>
      )}
    </div>
  )
}
