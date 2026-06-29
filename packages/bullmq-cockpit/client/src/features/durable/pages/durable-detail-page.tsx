import { Link, useNavigate } from "@tanstack/react-router"
import { CockpitIcon } from "@/lib/icons"
import { DurableInstancePanel } from "@/features/durable/components/durable-instance-panel"

export function DurableDetailPage({ instanceId }: { instanceId: string }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-1 text-sm text-foreground-400">
        <Link
          to="/durable"
          search={{ page: 1, pageSize: 50 }}
          className="transition-colors hover:text-foreground"
        >
          Durable
        </Link>
        <CockpitIcon name="chevronRight" width={14} />
        <span className="truncate font-mono text-xs text-foreground-600">{instanceId}</span>
      </div>
      <DurableInstancePanel
        instanceId={instanceId}
        onDeleted={() => navigate({ to: "/durable", search: { page: 1, pageSize: 50 } })}
      />
    </div>
  )
}
