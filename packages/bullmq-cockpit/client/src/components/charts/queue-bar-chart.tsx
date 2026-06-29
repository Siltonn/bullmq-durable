import { useEffect } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { QueueSummary } from "@shared/dto"
import { chartPalette } from "@/lib/chart"
import { truncate } from "@/lib/format"
import { ChartTooltip } from "./chart-tooltip"

/** A stacked bar per queue, broken down by live job state. */
export function QueueBarChart({ queues }: { queues: QueueSummary[] }) {
  // recharts' ResponsiveContainer can latch onto a width of 0 if it mounts
  // before this (full-width) card has been laid out, leaving the bars unrendered
  // until something triggers a re-measure. Nudge one on the next frame.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
    return () => cancelAnimationFrame(id)
  }, [])

  const palette = chartPalette()
  const data = queues.map((q) => ({
    name: truncate(q.name, 12),
    Active: q.counts.active,
    Waiting: q.counts.waiting + q.counts["waiting-children"],
    Delayed: q.counts.delayed,
    Failed: q.counts.failed,
  }))

  const series: Array<[key: string, color: string]> = [
    ["Active", palette.secondary],
    ["Waiting", palette.neutral],
    ["Delayed", palette.warning],
    ["Failed", palette.danger],
  ]

  return (
    // Wrap in an explicitly-sized box so ResponsiveContainer always has a
    // determinate parent to measure. Inside a flex/grid CardBody, a bare
    // ResponsiveContainer can measure width 0 on first paint and render nothing
    // (or NaN-geometry bars). The fixed-height, full-width box avoids that — the
    // same pattern the donut chart uses.
    <div className="h-[240px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, left: -18, bottom: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={palette.grid}
            strokeOpacity={0.35}
            vertical={false}
          />
          <XAxis
            dataKey="name"
            tick={{ fill: "hsl(var(--heroui-default-500))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: "hsl(var(--heroui-default-500))", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={36}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ fill: "hsl(var(--heroui-default-100))", opacity: 0.5 }}
          />
          {series.map(([key, color], i) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="jobs"
              fill={color}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
              maxBarSize={48}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
