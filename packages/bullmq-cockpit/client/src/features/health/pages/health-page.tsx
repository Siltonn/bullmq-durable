import { Button, Card, CardBody, Chip } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { RedisInfo, StuckInstance } from "@shared/dto"
import { MetricCard } from "@/components/ui/metric-card"
import { PageHeader } from "@/components/ui/page-header"
import { RelativeTime } from "@/components/ui/relative-time"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { useCockpitConfig } from "@/lib/providers/config"
import { formatBytes, formatDuration, formatNumber } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import { STUCK_LABELS } from "@/lib/status"

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-wider text-foreground-400">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-foreground-700">{value}</dd>
    </div>
  )
}

function RedisDetails({ info }: { info: RedisInfo }) {
  const hits = info.keyspaceHits ?? 0
  const misses = info.keyspaceMisses ?? 0
  const hitRate = hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : "—"
  return (
    <Card shadow="none" className="glass-card">
      <CardBody>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Version" value={info.version ?? "—"} />
          <Stat
            label="Uptime"
            value={info.uptimeSeconds ? formatDuration(info.uptimeSeconds * 1000) : "—"}
          />
          <Stat label="Memory used" value={info.usedMemoryHuman ?? formatBytes(info.usedMemory)} />
          <Stat
            label="Max memory"
            value={info.maxMemory ? formatBytes(info.maxMemory) : "no limit"}
          />
          <Stat label="Clients" value={info.connectedClients ?? "—"} />
          <Stat label="Ops / sec" value={info.opsPerSec ?? "—"} />
          <Stat label="Keys" value={info.dbKeys != null ? formatNumber(info.dbKeys) : "—"} />
          <Stat label="Hit rate" value={hitRate} />
          <Stat label="Evicted keys" value={info.evictedKeys ?? "—"} />
          <Stat label="Eviction policy" value={info.maxMemoryPolicy ?? "—"} />
        </dl>
      </CardBody>
    </Card>
  )
}

function StuckRow({ item }: { item: StuckInstance }) {
  return (
    <li className="flex flex-col gap-1 border-b border-default-100 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Chip size="sm" variant="flat" color="danger">
          {STUCK_LABELS[item.kind]}
        </Chip>
        <div className="min-w-0">
          <p className="text-sm text-foreground-700">{item.detail}</p>
          <p className="text-xs text-foreground-400">
            {item.queueName}
            {item.jobName ? ` · ${item.jobName}` : ""}
            {item.updatedAt ? (
              <>
                {" · updated "}
                <RelativeTime value={item.updatedAt} />
              </>
            ) : null}
          </p>
        </div>
      </div>
      {item.instanceId && (
        <Link to="/durable/$instanceId" params={{ instanceId: item.instanceId }}>
          <Button variant="light" endContent={<CockpitIcon name="chevronRight" width={16} />}>
            Inspect
          </Button>
        </Link>
      )}
    </li>
  )
}

export function HealthPage() {
  const config = useCockpitConfig()

  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 5000 })
  const redisInfo = useQuery({
    queryKey: ["redisInfo"],
    queryFn: api.redisInfo,
    refetchInterval: 8000,
  })
  const stuck = useQuery({
    queryKey: ["stuck"],
    queryFn: () => api.stuck(),
    enabled: config.durableEnabled,
    refetchInterval: 10000,
  })

  if (health.isLoading) return <LoadingState label="Checking health…" />
  if (health.error || !health.data)
    return <ErrorState error={health.error} onRetry={health.refetch} />

  const redis = health.data.redis

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Health"
        description="Connection status and durable stuck detection"
        icon="health"
        actions={
          <Button
            variant="flat"
            startContent={<CockpitIcon name="refresh" width={17} />}
            onPress={() => {
              void health.refetch()
              void stuck.refetch()
            }}
          >
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard
          label="Redis"
          value={redis.ok ? "Connected" : "Down"}
          icon={redis.ok ? "success" : "failed"}
          color={redis.ok ? "success" : "danger"}
          hint={redis.ok ? `${redis.latencyMs ?? 0}ms latency` : redis.error}
        />
        <MetricCard
          label="Durable"
          value={health.data.durableEnabled ? "Enabled" : "Disabled"}
          icon="durable"
          color={health.data.durableEnabled ? "primary" : "default"}
        />
        <MetricCard label="Queues" value={health.data.queues} icon="queues" />
      </div>

      {redisInfo.data && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground-500">
            <CockpitIcon name="database" width={16} className="text-foreground-400" /> Redis server
          </h2>
          <RedisDetails info={redisInfo.data} />
        </section>
      )}

      {config.durableEnabled && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground-500">Stuck instances</h2>
            {stuck.data && (
              <span className="text-xs text-foreground-400">
                threshold {formatDuration(stuck.data.thresholdMs)}
              </span>
            )}
          </div>

          {stuck.isLoading ? (
            <LoadingState label="Scanning for stuck instances…" />
          ) : stuck.error ? (
            <ErrorState error={stuck.error} onRetry={stuck.refetch} />
          ) : !stuck.data || stuck.data.stuck.length === 0 ? (
            <Card shadow="none" className="glass-card">
              <CardBody>
                <EmptyState
                  icon="success"
                  title="Nothing stuck"
                  description="No stale, missed, or orphaned instances detected."
                />
              </CardBody>
            </Card>
          ) : (
            <Card shadow="none" className="glass-card">
              <CardBody>
                <div className="mb-2 flex flex-wrap gap-2">
                  {Object.entries(stuck.data.countsByKind)
                    .filter(([, count]) => count > 0)
                    .map(([kind, count]) => (
                      <Chip key={kind} size="sm" variant="flat" color="danger">
                        {STUCK_LABELS[kind as keyof typeof STUCK_LABELS]}: {count}
                      </Chip>
                    ))}
                </div>
                <ul>
                  {stuck.data.stuck.map((item, index) => (
                    <StuckRow
                      key={`${item.kind}-${item.instanceId ?? item.jobId ?? index}`}
                      item={item}
                    />
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </section>
      )}
    </div>
  )
}
