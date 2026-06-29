import { formatNumber } from "@/lib/format"

export interface BarListItem {
  label: string
  value: number
  color?: string
  sublabel?: string
  onClick?: () => void
}

/** A ranked horizontal bar list (à la Tremor) — great for "queue depth". */
export function BarList({
  items,
  emptyLabel = "No data",
}: {
  items: BarListItem[]
  emptyLabel?: string
}) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-foreground-400">{emptyLabel}</p>
  }
  const max = Math.max(1, ...items.map((i) => i.value))

  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          disabled={!item.onClick}
          onClick={item.onClick}
          className="group block w-full text-left disabled:cursor-default"
        >
          <div className="mb-1 flex items-center justify-between gap-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-foreground-700 group-enabled:group-hover:text-foreground">
                {item.label}
              </span>
              {item.sublabel && (
                <span className="shrink-0 text-xs text-foreground-400">{item.sublabel}</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-foreground-500">
              {formatNumber(item.value)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-default-100">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${Math.max(2, (item.value / max) * 100)}%`,
                background: item.color ?? "hsl(var(--heroui-primary))",
              }}
            />
          </div>
        </button>
      ))}
    </div>
  )
}
