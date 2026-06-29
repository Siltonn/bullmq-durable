import { Card, CardBody } from "@heroui/react"
import { CockpitIcon, type IconName } from "@/lib/icons"
import type { ChipColor } from "@/lib/status"
import { chipTint } from "@/lib/tokens"
import { formatNumber } from "@/lib/format"

export interface Attention {
  icon: IconName
  count: number
  label: string
  color: ChipColor
  onClick: () => void
}

/**
 * One compact line that answers "is anything wrong?". A status dot + verdict on
 * the left, and a chip per *non-zero* problem on the right — each a shortcut to
 * the thing that needs fixing. When all clear, it's just the green verdict.
 */
export function HealthStrip({
  tone,
  verdict,
  items,
}: {
  tone: ChipColor
  verdict: string
  items: Attention[]
}) {
  const border =
    tone === "danger" ? "border-danger/30" : tone === "warning" ? "border-warning/30" : ""
  return (
    <Card shadow="none" className={`glass-card ${border}`}>
      <CardBody className="flex-row flex-wrap items-center gap-x-4 gap-y-2 p-3 sm:px-4">
        <div className="flex items-center gap-2.5">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-medium ${chipTint[tone]}`}
          >
            <CockpitIcon
              name={tone === "danger" ? "alert" : tone === "warning" ? "stuck" : "success"}
              width={16}
            />
          </span>
          <span className="text-sm font-medium text-foreground">{verdict}</span>
        </div>
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {items.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                className={`flex items-center gap-1.5 rounded-medium px-2.5 py-1 text-sm transition-opacity hover:opacity-80 ${chipTint[a.color]}`}
              >
                <CockpitIcon name={a.icon} width={14} />
                <span className="font-semibold tabular-nums">{formatNumber(a.count)}</span>
                <span className="opacity-80">{a.label}</span>
              </button>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
