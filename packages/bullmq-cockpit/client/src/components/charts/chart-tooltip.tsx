import type { TooltipProps } from "recharts"

/** A themed Recharts tooltip matching the HeroUI surface styling. */
export function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="glass-card rounded-medium px-3 py-2 shadow-medium">
      {label !== undefined && label !== "" && (
        <div className="mb-1 text-xs font-medium text-foreground-500">{label}</div>
      )}
      <ul className="space-y-0.5">
        {payload.map((entry, index) => (
          <li key={index} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 rounded-xs"
              style={{ background: entry.color ?? (entry.payload?.color as string) }}
            />
            <span className="text-foreground-600">{entry.name}</span>
            <span className="ml-auto font-medium tabular-nums text-foreground">{entry.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
