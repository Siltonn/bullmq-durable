import { Card, CardBody, CardHeader, Tab, Tabs } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import type { LatencyStats, MetricPoint, MetricSeries } from "@shared/dto"
import { BarList, type BarListItem } from "@/components/charts/bar-list"
import { ThroughputChart } from "@/components/charts/throughput-chart"
import { MetricCard } from "@/components/ui/metric-card"
import { PageHeader } from "@/components/ui/page-header"
import { QueuePicker } from "@/components/ui/queue-picker"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { chartPalette } from "@/lib/chart"
import { formatDuration, formatNumber } from "@/lib/format"
import { RANGES } from "@/features/metrics/config/constants"

const tail = <T,>(arr: T[], n: number): T[] => (n > 0 ? arr.slice(-n) : arr)
const fmtRate = (n: number) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1))

/** A small avg / p50 / p95 / max stat block with a p50→p95→max bar. */
function LatencyBlock({ title, stats }: { title: string; stats: LatencyStats }) {
  const scale = Math.max(1, stats.max)
  const seg = (label: string, value: number, cls: string) => (
    <div className="flex items-center gap-2.5">
      <span className="w-9 shrink-0 text-[11px] uppercase tracking-wide text-foreground-400">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-default-100">
        <div
          className={`h-full rounded-full ${cls}`}
          style={{ width: `${(value / scale) * 100}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-sm tabular-nums text-foreground-700">
        {formatDuration(value)}
      </span>
    </div>
  )
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-foreground-600">{title}</h4>
        <span className="text-[11px] text-foreground-400">
          {stats.sampled > 0 ? `${formatNumber(stats.sampled)} samples` : "no data"}
        </span>
      </div>
      {stats.sampled > 0 ? (
        <div className="space-y-2">
          {seg("avg", stats.avg, "bg-secondary")}
          {seg("p50", stats.p50, "bg-secondary/70")}
          {seg("p95", stats.p95, "bg-warning")}
          {seg("max", stats.max, "bg-danger/70")}
        </div>
      ) : (
        <p className="py-2 text-xs text-foreground-400">Needs recent completed jobs to measure.</p>
      )}
    </div>
  )
}

export function MetricsPage() {
  const { data: queues } = useQuery({ queryKey: ["queues"], queryFn: api.queues })
  const [queue, setQueue] = useState<string | undefined>(undefined)
  const [range, setRange] = useState("60")
  const minutes = RANGES.find(([key]) => key === range)?.[2] ?? 60

  useEffect(() => {
    if (!queue && queues && queues.length > 0) setQueue(queues[0]!.name)
  }, [queue, queues])

  const { data: metrics } = useQuery({
    queryKey: ["metrics", queue],
    queryFn: () => api.metrics(queue!),
    enabled: Boolean(queue),
    refetchInterval: 10_000,
  })
  const {
    data: activity,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["activity", queue, minutes],
    queryFn: () => api.queueActivity(queue!, minutes),
    enabled: Boolean(queue),
    refetchInterval: 10_000,
  })

  const palette = chartPalette()

  // Throughput series: BullMQ metrics when the worker opted in (longer history),
  // otherwise the derived per-minute buckets — so the chart always has data.
  const series = useMemo(() => {
    const enabled = metrics?.enabled
    const completedPts: MetricPoint[] = enabled
      ? tail(metrics!.completed.points, minutes)
      : (activity?.perMinute ?? []).map((p) => ({ t: p.t, value: p.completed }))
    const failedPts: MetricPoint[] = enabled
      ? tail(metrics!.failed.points, minutes)
      : (activity?.perMinute ?? []).map((p) => ({ t: p.t, value: p.failed }))
    const completed: MetricSeries = { name: "completed", count: 0, points: completedPts }
    const failed: MetricSeries = { name: "failed", count: 0, points: failedPts }
    const total =
      completedPts.reduce((s, p) => s + p.value, 0) + failedPts.reduce((s, p) => s + p.value, 0)
    return { completed, failed, total, derived: !enabled }
  }, [metrics, activity, minutes])

  const jobNames: BarListItem[] = (activity?.jobNames ?? []).map((n) => ({
    label: n.name,
    value: n.completed + n.failed,
    sublabel: n.failed > 0 ? `${n.failed} failed` : undefined,
    color: n.failed > 0 ? palette.warning : palette.secondary,
  }))

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Metrics"
        description="Throughput, latency & errors per queue"
        icon="metrics"
        actions={
          <div className="flex items-center gap-2.5">
            <Tabs
              size="sm"
              variant="bordered"
              selectedKey={range}
              onSelectionChange={(k) => setRange(String(k))}
              aria-label="Time range"
            >
              {RANGES.map(([key, label]) => (
                <Tab key={key} title={label} />
              ))}
            </Tabs>
            <QueuePicker queues={queues ?? []} value={queue} onChange={setQueue} className="w-52" />
          </div>
        }
      />

      {!queue ? (
        <EmptyState
          icon="metrics"
          title="Pick a queue"
          description="Select a queue to see its signals."
        />
      ) : isLoading ? (
        <LoadingState label="Measuring…" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !activity ? null : (
        <>
          {/* Golden-signal KPIs */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <MetricCard
              label="Throughput"
              value={`${fmtRate(activity.throughputPerMin)}/min`}
              icon="metrics"
              color="secondary"
            />
            <MetricCard
              label="Error rate"
              value={`${(activity.failureRate * 100).toFixed(1)}%`}
              icon="failed"
              color={
                activity.failureRate > 0.1
                  ? "danger"
                  : activity.failureRate > 0
                    ? "warning"
                    : "success"
              }
              share={activity.failureRate}
            />
            <MetricCard
              label="p50 duration"
              value={formatDuration(activity.processing.p50)}
              icon="timer"
              color="secondary"
            />
            <MetricCard
              label="p95 duration"
              value={formatDuration(activity.processing.p95)}
              icon="timer"
              color={activity.processing.p95 > 5000 ? "warning" : "default"}
            />
            <MetricCard
              label="Avg queue wait"
              value={formatDuration(activity.wait.avg)}
              icon="clock"
              color={activity.wait.avg > 60_000 ? "warning" : "default"}
            />
          </div>

          {/* Throughput over time */}
          <Card shadow="none" className="glass-card">
            <CardHeader className="flex items-center justify-between px-5 pb-0 pt-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Throughput</h2>
                <p className="text-[13px] text-foreground-400">
                  Jobs per minute · {queue}
                  {series.derived ? " · derived from recent jobs" : ""}
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-foreground-500">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-xs bg-success" /> Completed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-xs bg-danger" /> Failed
                </span>
              </div>
            </CardHeader>
            <CardBody className="px-3 pb-3 pt-2">
              {series.total === 0 ? (
                <EmptyState
                  icon="metrics"
                  title="No throughput yet"
                  description="Once jobs complete or fail in this window, their per-minute counts appear here."
                />
              ) : (
                <ThroughputChart completed={series.completed} failed={series.failed} />
              )}
            </CardBody>
          </Card>

          {/* Latency + job-name breakdown */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card shadow="none" className="glass-card">
              <CardHeader className="flex items-center gap-2 px-5 pb-0 pt-4">
                <h2 className="text-base font-semibold text-foreground">Latency</h2>
                <span className="text-[13px] text-foreground-400">processing vs queue wait</span>
              </CardHeader>
              <CardBody className="gap-5">
                <LatencyBlock title="Processing time" stats={activity.processing} />
                <LatencyBlock title="Queue wait" stats={activity.wait} />
              </CardBody>
            </Card>

            <Card shadow="none" className="glass-card">
              <CardHeader className="flex items-center gap-2 px-5 pb-0 pt-4">
                <h2 className="text-base font-semibold text-foreground">By job name</h2>
                <span className="text-[13px] text-foreground-400">
                  last {activity.windowMinutes}m
                </span>
              </CardHeader>
              <CardBody>
                <BarList items={jobNames} emptyLabel="No recent jobs to break down." />
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
