/**
 * A workbench-style status filter: a tab bar with a live count per state. This
 * is the primary way to slice a queue's jobs (clearer than a status dropdown,
 * and the counts double as an at-a-glance health read).
 */

import { Tab, Tabs } from "@heroui/react"
import type { JobCounts } from "@shared/dto"
import { formatCompact } from "@/lib/format"
import type { ChipColor } from "@/lib/status"
import { chipBadge } from "@/lib/tokens"

interface StatusItem {
  key: string
  label: string
  color?: ChipColor
  /** Key into JobCounts, or "all" for the sum. */
  count: keyof JobCounts | "all"
}

const ITEMS: StatusItem[] = [
  { key: "all", label: "All", count: "all" },
  { key: "active", label: "Active", color: "secondary", count: "active" },
  { key: "waiting", label: "Waiting", count: "waiting" },
  { key: "delayed", label: "Delayed", color: "warning", count: "delayed" },
  { key: "prioritized", label: "Prioritized", color: "default", count: "prioritized" },
  { key: "completed", label: "Completed", color: "success", count: "completed" },
  { key: "failed", label: "Failed", color: "danger", count: "failed" },
  { key: "paused", label: "Paused", color: "default", count: "paused" },
]

function total(counts: JobCounts): number {
  return (
    counts.waiting +
    counts.active +
    counts.delayed +
    counts.completed +
    counts.failed +
    counts.paused +
    counts.prioritized +
    counts["waiting-children"]
  )
}

export function JobStatusTabs({
  counts,
  value,
  onChange,
}: {
  counts?: JobCounts
  value: string
  onChange: (status: string) => void
}) {
  const countFor = (item: StatusItem): number => {
    if (!counts) return 0
    return item.count === "all" ? total(counts) : counts[item.count]
  }

  return (
    <Tabs
      aria-label="Job status"
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      variant="underlined"
      classNames={{
        base: "w-full",
        tabList: "w-full flex-nowrap overflow-x-auto gap-1.5 px-0",
        cursor: "bg-primary h-0.5",
        tab: "px-3.5 h-11",
        tabContent: "text-[15px]",
      }}
    >
      {ITEMS.map((item) => {
        const n = countFor(item)
        const badge =
          n > 0 ? chipBadge[item.color ?? "default"] : "bg-default-100 text-foreground-400"
        return (
          <Tab
            key={item.key}
            title={
              <div className="flex items-center gap-2">
                <span className="font-medium">{item.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[12px] font-semibold tabular-nums ${badge}`}
                >
                  {formatCompact(n)}
                </span>
              </div>
            }
          />
        )
      })}
    </Tabs>
  )
}
