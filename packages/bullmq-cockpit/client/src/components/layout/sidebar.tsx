import { Link } from "@tanstack/react-router"
import { useCockpitConfig } from "@/lib/providers/config"
import { CockpitIcon, type IconName } from "@/lib/icons"
import { Logo } from "./logo"

interface NavItem {
  to: string
  label: string
  icon: IconName
  exact?: boolean
}

interface NavSection {
  label: string
  items: NavItem[]
}

/** Primary navigation. Active links are styled via TanStack Router's
 *  `data-status="active"` attribute, so no className merging is needed. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const config = useCockpitConfig()

  const sections: NavSection[] = [
    {
      label: "Monitor",
      items: [
        { to: "/", label: "Overview", icon: "dashboard", exact: true },
        { to: "/queues", label: "Queues", icon: "queues" },
        { to: "/jobs", label: "Jobs", icon: "jobs" },
        { to: "/flows", label: "Flows", icon: "flows" },
        { to: "/schedulers", label: "Schedulers", icon: "schedulers" },
        { to: "/metrics", label: "Metrics", icon: "metrics" },
      ],
    },
    ...(config.durableEnabled
      ? [
          {
            label: "Durable",
            items: [{ to: "/durable", label: "Instances", icon: "durable" as IconName }],
          },
        ]
      : []),
    {
      label: "System",
      items: [
        { to: "/alerts", label: "Alerts", icon: "alerts" },
        { to: "/health", label: "Health", icon: "health" },
      ],
    },
  ]

  return (
    <nav className="flex h-full flex-col gap-0.5 p-3">
      <div className="mb-5 flex items-center gap-3 px-2 pt-1.5">
        <Logo size={38} />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">
            BullMQ Cockpit
          </div>
          <div className="text-[11px] text-foreground-400">v{config.version}</div>
        </div>
      </div>

      {sections.map((section) => (
        <div key={section.label} className="mb-2">
          <span className="mb-1 block px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground-400">
            {section.label}
          </span>
          {section.items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              activeOptions={{ exact: item.exact ?? false }}
              className="group relative mx-1 flex items-center gap-3 rounded-medium px-3 py-2.5 text-[15px] font-medium text-foreground-500 transition-colors hover:bg-default-100/70 hover:text-foreground data-[status=active]:bg-default-100 data-[status=active]:text-foreground"
            >
              <span className="absolute left-0 top-1/2 h-5 w-1 -translate-x-2 -translate-y-1/2 rounded-r-full bg-primary opacity-0 transition-opacity group-data-[status=active]:opacity-100" />
              <span className="text-foreground-400 transition-colors group-hover:text-foreground-600 group-data-[status=active]:text-primary">
                <CockpitIcon name={item.icon} width={19} />
              </span>
              {item.label}
            </Link>
          ))}
        </div>
      ))}

      <div className="mt-auto px-1">
        {config.readonly && (
          <div className="flex items-center gap-2 rounded-medium border border-warning-200 bg-warning-50/60 px-3 py-2 text-xs text-warning-700 dark:bg-warning-50/10">
            <CockpitIcon name="lock" width={15} />
            Read-only mode
          </div>
        )}
      </div>
    </nav>
  )
}
