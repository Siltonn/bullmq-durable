import type { DurableEvent, DurableLogEntry } from "@shared/dto"
import { RelativeTime } from "@/components/ui/relative-time"
import { EmptyState } from "@/components/ui/states"
import { formatDateTime } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"

const EVENT_COLOR: Record<DurableEvent["level"], string> = {
  info: "text-foreground-400",
  warn: "text-warning",
  error: "text-danger",
}

export function EventsView({ events }: { events?: DurableEvent[] }) {
  if (!events || events.length === 0) return <EmptyState icon="logs" title="No events" />
  return (
    <ol className="space-y-2">
      {[...events].reverse().map((event, index) => (
        <li key={index} className="flex gap-3 text-sm">
          <CockpitIcon
            name="clock"
            width={14}
            className={`mt-1 shrink-0 ${EVENT_COLOR[event.level]}`}
          />
          <div className="min-w-0 flex-1">
            <span className="text-foreground-700">{event.message}</span>
            <span className="ml-2 text-xs text-foreground-400">
              <RelativeTime value={event.timestamp} />
            </span>
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * Structured log list. 0.2.x entries carry attribution (which delivery, which
 * step + attempt, runtime event codes); older/foreign lines degrade to plain
 * time + message rows.
 */
export function LogsView({ logs }: { logs?: DurableLogEntry[] }) {
  if (!logs || logs.length === 0) return <EmptyState icon="logs" title="No logs" />

  // Insert a divider whenever the delivery (runCount) changes, so multi-tick
  // runs read as "what happened on delivery #2" instead of one merged stream.
  const rows: Array<{ divider: number } | { log: DurableLogEntry }> = []
  let lastRun: number | undefined
  const multiDelivery = new Set(logs.map((l) => l.runCount).filter((r) => r !== undefined)).size > 1
  for (const log of logs) {
    if (multiDelivery && log.runCount !== undefined && log.runCount !== lastRun) {
      lastRun = log.runCount
      rows.push({ divider: log.runCount })
    }
    rows.push({ log })
  }

  return (
    <ol className="overflow-hidden rounded-medium border border-default-200 font-mono text-xs">
      {rows.map((row, index) =>
        "divider" in row ? (
          <li
            key={`delivery-${row.divider}-${index}`}
            className="border-b border-default-100 bg-default-100/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-foreground-400"
          >
            Delivery #{row.divider}
          </li>
        ) : (
          <LogRow key={index} log={row.log} />
        ),
      )}
    </ol>
  )
}

function LogRow({ log }: { log: DurableLogEntry }) {
  const isEvent = log.kind === "event"
  const isRaw = log.kind === "raw"
  return (
    <li className="flex gap-3 border-b border-default-100 px-3 py-2 last:border-b-0 odd:bg-default-50/50">
      <span className="select-none text-foreground-300">
        {formatDateTime(log.timestamp).split(", ")[2] ?? ""}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground-600">
        {log.step && (
          <span className="mr-2 inline-block rounded bg-default-100 px-1 align-middle text-[10px] text-foreground-500">
            {log.step}
            {log.stepAttempt !== undefined && log.stepAttempt > 1 ? `#${log.stepAttempt}` : ""}
          </span>
        )}
        {isEvent && (
          <span className="mr-2 inline-block rounded bg-warning/10 px-1 align-middle text-[10px] text-warning">
            {log.event ?? "event"}
          </span>
        )}
        {isRaw && (
          <span className="mr-2 inline-block align-middle text-[10px] italic text-foreground-300">
            raw
          </span>
        )}
        {log.message}
        {log.err && <span className="text-danger"> — {log.err.message}</span>}
      </span>
    </li>
  )
}
