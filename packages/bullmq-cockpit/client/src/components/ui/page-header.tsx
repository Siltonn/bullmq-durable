import type { ReactNode } from "react"
import { CockpitIcon, type IconName } from "@/lib/icons"

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  icon?: IconName
  actions?: ReactNode
}

export function PageHeader({ title, description, icon, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3.5">
        {icon && (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-large bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
            <CockpitIcon name={icon} width={22} />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description && <p className="mt-0.5 text-[15px] text-foreground-500">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
