import { Card, CardBody } from "@heroui/react"
import { CockpitIcon, type IconName } from "@/lib/icons"
import type { ChipColor } from "@/lib/status"
import { chipSolid, chipTint } from "@/lib/tokens"

export interface MetricCardProps {
  label: string
  value: string | number
  icon?: IconName
  color?: ChipColor
  hint?: string
  /** A 0–1 ratio; when set, renders a share bar instead of the hint text. */
  share?: number
  onPress?: () => void
}

/** A KPI tile with a tinted icon and an optional share bar. */
export function MetricCard({
  label,
  value,
  icon,
  color = "default",
  hint,
  share,
  onPress,
}: MetricCardProps) {
  return (
    <Card
      shadow="none"
      isPressable={Boolean(onPress)}
      onPress={onPress}
      className="glass-card transition-colors hover:border-default-300"
    >
      <CardBody className="gap-3 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground-400">
            {label}
          </span>
          {icon && (
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-medium ${chipTint[color]}`}
            >
              <CockpitIcon name={icon} width={18} />
            </span>
          )}
        </div>
        <div className="text-[28px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
          {value}
        </div>
        {share !== undefined ? (
          <div className="h-1 overflow-hidden rounded-full bg-default-100">
            <div
              className={`h-full rounded-full ${chipSolid[color]} transition-[width] duration-500`}
              style={{ width: `${Math.min(100, Math.max(share > 0 ? 3 : 0, share * 100))}%` }}
            />
          </div>
        ) : (
          hint && <div className="truncate text-xs text-foreground-400">{hint}</div>
        )}
      </CardBody>
    </Card>
  )
}
