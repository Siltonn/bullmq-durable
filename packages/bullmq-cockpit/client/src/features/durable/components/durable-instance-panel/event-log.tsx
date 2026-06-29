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

export function LogsView({ logs }: { logs?: DurableLogEntry[] }) {
  if (!logs || logs.length === 0) return <EmptyState icon="logs" title="No logs" />
  return (
    <ol className="overflow-hidden rounded-medium border border-default-200 font-mono text-xs">
      {logs.map((log, index) => (
        <li
          key={index}
          className="flex gap-3 border-b border-default-100 px-3 py-2 last:border-b-0 odd:bg-default-50/50"
        >
          <span className="select-none text-foreground-300">
            {formatDateTime(log.timestamp).split(", ")[2] ?? ""}
          </span>
          <span className="whitespace-pre-wrap break-all text-foreground-600">{log.message}</span>
        </li>
      ))}
    </ol>
  )
}
