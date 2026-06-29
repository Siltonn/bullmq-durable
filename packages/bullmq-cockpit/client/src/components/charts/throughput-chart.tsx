import { useEffect } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { MetricSeries } from "@shared/dto"
import { chartPalette } from "@/lib/chart"
import { ChartTooltip } from "./chart-tooltip"

/** Completed vs failed throughput over time, as two gradient area series. */
export function ThroughputChart({
  completed,
  failed,
}: {
  completed: MetricSeries
  failed: MetricSeries
}) {
  // Same width-0 guard the other recharts wrappers use.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
    return () => cancelAnimationFrame(id)
  }, [])

  const palette = chartPalette()
  const len = Math.max(completed.points.length, failed.points.length)
  const data = Array.from({ length: len }, (_, i) => {
    const c = completed.points[i]
    const f = failed.points[i]
    const t = c?.t ?? f?.t
    return {
      label: t
        ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : "",
      Completed: c?.value ?? 0,
      Failed: f?.value ?? 0,
    }
  })

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="grad-completed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.success} stopOpacity={0.35} />
              <stop offset="100%" stopColor={palette.success} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="grad-failed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.danger} stopOpacity={0.3} />
              <stop offset="100%" stopColor={palette.danger} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={palette.grid}
            strokeOpacity={0.35}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: "hsl(var(--heroui-default-500))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
          />
          <YAxis
            tick={{ fill: "hsl(var(--heroui-default-500))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={36}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: palette.grid, strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="Completed"
            stroke={palette.success}
            fill="url(#grad-completed)"
            strokeWidth={2}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="Failed"
            stroke={palette.danger}
            fill="url(#grad-failed)"
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
