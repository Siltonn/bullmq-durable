import { Card, CardBody, Chip } from "@heroui/react"
import type { DurableStatusCounts } from "@shared/dto"
import { CompositionBar } from "@/components/ui/composition-bar"
import { formatCompact, formatNumber } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"

export const DUR_DOT: Record<string, string> = {
  running: "bg-secondary",
  sleeping: "bg-default-300",
  retrying: "bg-warning",
  compensating: "bg-warning",
  completed: "bg-success",
  failed: "bg-danger",
  compensation_failed: "bg-danger",
}
export const DUR_TEXT: Record<string, string> = {
  running: "text-secondary",
  sleeping: "text-foreground-700",
  retrying: "text-warning",
  compensating: "text-warning",
  completed: "text-success",
  failed: "text-danger",
  compensation_failed: "text-danger",
}

/**
 * A single compact card for the durable picture — a composition bar plus a
 * clickable per-state strip. Replaces the old donut + lifecycle tiles (which
 * showed the same numbers twice).
 */
export function DurableSummary({
  d,
  onStatus,
  onAll,
}: {
  d: DurableStatusCounts
  onStatus: (status: string) => void
  onAll: () => void
}) {
  const stats = [
    { key: "running", label: "Running", value: d.running },
    { key: "sleeping", label: "Sleeping", value: d.sleeping },
    { key: "retrying", label: "Retrying", value: d.retrying },
    { key: "completed", label: "Done", value: d.completed },
    { key: "failed", label: "Failed", value: d.failed },
  ]
  return (
    <Card shadow="none" className="glass-card">
      <CardBody className="gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={onAll} className="group flex items-center gap-2 text-left">
            <CockpitIcon name="durable" width={16} className="text-foreground-400" />
            <span className="font-semibold text-foreground transition-colors group-hover:text-secondary">
              Durable instances
            </span>
            {d.stuck > 0 && (
              <Chip
                size="sm"
                variant="flat"
                color="warning"
                startContent={<CockpitIcon name="stuck" width={12} />}
              >
                {d.stuck} stuck
              </Chip>
            )}
            {d.compensation_failed > 0 && (
              <Chip
                size="sm"
                variant="flat"
                color="danger"
                startContent={<CockpitIcon name="compensationFailed" width={12} />}
                onClick={(e) => {
                  e.stopPropagation()
                  onStatus("compensation_failed")
                }}
                className="cursor-pointer"
              >
                {d.compensation_failed} needs attention
              </Chip>
            )}
          </button>
          <span className="shrink-0 text-xs tabular-nums text-foreground-400">
            {formatNumber(d.total)} total
          </span>
        </div>

        <CompositionBar
          segments={[
            { label: "Completed", value: d.completed, className: "bg-success" },
            { label: "Running", value: d.running, className: "bg-secondary" },
            { label: "Sleeping", value: d.sleeping, className: "bg-default-300" },
            { label: "Retrying", value: d.retrying, className: "bg-warning" },
            { label: "Compensating", value: d.compensating, className: "bg-warning/70" },
            { label: "Failed", value: d.failed, className: "bg-danger" },
            { label: "Compensation failed", value: d.compensation_failed, className: "bg-danger/80" },
            { label: "Cancelled", value: d.cancelled, className: "bg-default-200" },
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
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DUR_DOT[s.key]}`} />
                <span className="text-[10px] uppercase tracking-wide text-foreground-400">
                  {s.label}
                </span>
              </div>
              <div
                className={`mt-1 text-lg font-semibold tabular-nums ${s.value > 0 ? DUR_TEXT[s.key] : "text-foreground-300"}`}
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
