/**
 * A Bull-Board-style queue card: name + health + worker count, a thin
 * composition bar, and a clickable per-state stat strip. Built for scanning
 * many queues at a glance on the overview.
 */

import { Card, CardBody, Chip } from "@heroui/react"
import type { QueueSummary } from "@shared/dto"
import { formatCompact, formatNumber } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import type { ChipColor } from "@/lib/status"
import { CompositionBar } from "@/components/ui/composition-bar"

function health(q: QueueSummary): { label: string; color: ChipColor } {
  const pending = q.counts.waiting + q.counts.delayed + q.counts["waiting-children"]
  if (q.isPaused) return { label: "Paused", color: "warning" }
  if (q.counts.active > 0) return { label: "Processing", color: "secondary" }
  if (pending > 0 && q.workers === 0) return { label: "No workers", color: "danger" }
  if (pending > 0) return { label: "Queued", color: "default" }
  return { label: "Idle", color: "default" }
}

const DOT: Record<string, string> = {
  active: "bg-secondary",
  waiting: "bg-default-300",
  delayed: "bg-warning",
  completed: "bg-success",
  failed: "bg-danger",
}
const TEXT: Record<string, string> = {
  active: "text-secondary",
  waiting: "text-foreground-700",
  delayed: "text-warning",
  completed: "text-success",
  failed: "text-danger",
}

export function QueueCard({
  queue,
  onOpen,
  onStatus,
}: {
  queue: QueueSummary
  onOpen: () => void
  onStatus: (status: string) => void
}) {
  const c = queue.counts
  const h = health(queue)
  const starved = queue.workers === 0 && c.waiting + c.delayed + c.active > 0
  const stats: Array<{ key: string; label: string; value: number }> = [
    { key: "active", label: "Active", value: c.active },
    { key: "waiting", label: "Wait", value: c.waiting + c["waiting-children"] },
    { key: "delayed", label: "Delay", value: c.delayed },
    { key: "completed", label: "Done", value: c.completed },
    { key: "failed", label: "Fail", value: c.failed },
  ]

  return (
    <Card shadow="none" className="glass-card transition-colors hover:border-default-300">
      <CardBody className="gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="group flex min-w-0 items-center gap-2 text-left"
          >
            <span className="truncate font-semibold text-foreground transition-colors group-hover:text-secondary">
              {queue.name}
            </span>
            <Chip size="sm" variant="flat" color={h.color}>
              {h.label}
            </Chip>
          </button>
          <span
            className={`flex shrink-0 items-center gap-1 text-xs ${starved ? "text-danger" : "text-foreground-400"}`}
            title={`${queue.workers} worker(s)`}
          >
            <CockpitIcon name="workers" width={14} />
            <span className="tabular-nums">{formatNumber(queue.workers)}</span>
          </span>
        </div>

        <CompositionBar
          className="w-full"
          segments={[
            { label: "Completed", value: c.completed, className: "bg-success" },
            { label: "Active", value: c.active, className: "bg-secondary" },
            {
              label: "Waiting",
              value: c.waiting + c["waiting-children"],
              className: "bg-default-300",
            },
            { label: "Delayed", value: c.delayed, className: "bg-warning" },
            { label: "Failed", value: c.failed, className: "bg-danger" },
          ]}
        />

        <div className="grid grid-cols-5 gap-1">
          {stats.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => onStatus(s.key)}
              className="rounded-medium px-1.5 py-1 text-left transition-colors hover:bg-default-100"
            >
              <div className="flex items-center gap-1">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s.key]}`} />
                <span className="text-[10px] uppercase tracking-wide text-foreground-400">
                  {s.label}
                </span>
              </div>
              <div
                className={`mt-1 text-lg font-semibold tabular-nums ${s.value > 0 ? TEXT[s.key] : "text-foreground-300"}`}
              >
                {formatCompact(s.value)}
              </div>
            </button>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}
