import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import { formatNumber } from "@/lib/format"
import { ChartTooltip } from "./chart-tooltip"

export interface DonutDatum {
  name: string
  value: number
  color: string
}

/** A donut chart with a centered total and a colour-keyed legend list. */
export function DonutChart({
  data,
  centerLabel = "total",
  onSliceClick,
}: {
  data: DonutDatum[]
  centerLabel?: string
  onSliceClick?: (datum: DonutDatum) => void
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0)
  // Recharts renders nothing when every value is 0 — show a hollow grey ring.
  const slices =
    total === 0 ? [{ name: "empty", value: 1, color: "hsl(var(--heroui-default-200))" }] : data

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-[148px] w-[148px] shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              innerRadius="70%"
              outerRadius="100%"
              paddingAngle={total === 0 ? 0 : 2}
              stroke="none"
              startAngle={90}
              endAngle={-270}
              onClick={
                onSliceClick && total > 0
                  ? (entry: { payload?: DonutDatum }) =>
                      entry.payload && onSliceClick(entry.payload)
                  : undefined
              }
            >
              {slices.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.color}
                  className={
                    onSliceClick && total > 0 ? "cursor-pointer outline-hidden" : "outline-hidden"
                  }
                />
              ))}
            </Pie>
            {total > 0 && <Tooltip content={<ChartTooltip />} />}
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {formatNumber(total)}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-foreground-400">
            {centerLabel}
          </span>
        </div>
      </div>

      <ul className="grid w-full flex-1 grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-1">
        {data.map((d) => (
          <li key={d.name}>
            <button
              type="button"
              disabled={!onSliceClick}
              onClick={() => onSliceClick?.(d)}
              className="flex w-full items-center gap-2 rounded-small text-sm transition-colors enabled:hover:text-foreground disabled:cursor-default"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
              <span className="truncate text-foreground-600">{d.name}</span>
              <span className="ml-auto font-medium tabular-nums text-foreground-500">
                {formatNumber(d.value)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
