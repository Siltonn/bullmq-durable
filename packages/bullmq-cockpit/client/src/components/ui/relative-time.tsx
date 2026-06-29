/** Live, self-updating relative timestamps and countdowns. */

import { formatCountdown, formatDateTime, formatRelative } from "@/lib/format"
import { useNow } from "@/lib/use-now"

/** "3m ago" — updates every minute, or every second when `live`. */
export function RelativeTime({ value, live = false }: { value?: number; live?: boolean }) {
  const now = useNow(live ? 1000 : 30_000)
  return (
    <span title={formatDateTime(value)} className="tabular-nums">
      {formatRelative(value, now)}
    </span>
  )
}

/** "in 8s" / "overdue 3s" — ticks every second. */
export function Countdown({ target }: { target?: number }) {
  const now = useNow(1000)
  if (target === undefined) return <span className="text-foreground-400">—</span>
  const overdue = target - now <= 0
  return (
    <span
      className={overdue ? "text-warning tabular-nums" : "tabular-nums"}
      title={formatDateTime(target)}
    >
      {formatCountdown(target, now)}
    </span>
  )
}
