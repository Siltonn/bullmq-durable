import type { ReactNode } from "react"
import { CockpitIcon, type IconName } from "@/lib/icons"

export function SectionHeader({
  icon,
  title,
  action,
}: {
  icon: IconName
  title: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-foreground-500">
        <CockpitIcon name={icon} width={15} className="text-foreground-400" />
        {title}
      </h2>
      {action}
    </div>
  )
}
