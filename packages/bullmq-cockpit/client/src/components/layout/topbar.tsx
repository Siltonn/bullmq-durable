import { Avatar, Button, Chip, Kbd } from "@heroui/react"
import { useCockpitConfig } from "@/lib/providers/config"
import { CockpitIcon } from "@/lib/icons"
import { TimeZonePicker } from "@/components/ui/time-zone-picker"

export interface TopbarProps {
  onOpenNav: () => void
  onOpenCommand: () => void
  theme: "light" | "dark"
  onToggleTheme: () => void
}

export function Topbar({ onOpenNav, onOpenCommand, theme, onToggleTheme }: TopbarProps) {
  const config = useCockpitConfig()

  return (
    <header className="glass-chrome sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-default-200/50 px-3 sm:px-5">
      <Button
        isIconOnly
        variant="light"
        size="sm"
        className="lg:hidden"
        onPress={onOpenNav}
        aria-label="Open navigation"
      >
        <CockpitIcon name="menu" width={20} />
      </Button>

      <button
        type="button"
        onClick={onOpenCommand}
        className="flex items-center gap-2 rounded-medium border border-default-200/60 bg-default-100/40 px-3 py-1.5 text-sm text-foreground-400 transition-colors hover:bg-default-100/70"
      >
        <CockpitIcon name="search" width={16} />
        <span className="hidden sm:inline">Jump to…</span>
        <Kbd className="hidden sm:inline-block" keys={["command"]}>
          K
        </Kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        {config.readonly && (
          <Chip
            size="sm"
            variant="flat"
            color="warning"
            startContent={<CockpitIcon name="lock" width={13} />}
          >
            Read-only
          </Chip>
        )}
        <TimeZonePicker />
        <Button
          isIconOnly
          variant="light"
          size="sm"
          onPress={onToggleTheme}
          aria-label="Toggle theme"
        >
          <CockpitIcon name={theme === "dark" ? "sun" : "moon"} width={18} />
        </Button>
        {config.user && (
          <div className="flex items-center gap-2 pl-1">
            <Avatar
              name={(config.user.name ?? config.user.id).slice(0, 2).toUpperCase()}
              size="sm"
            />
            <div className="hidden leading-tight sm:block">
              <div className="text-sm font-medium text-foreground">
                {config.user.name ?? config.user.id}
              </div>
              {config.user.role && (
                <div className="text-[11px] text-foreground-400">{config.user.role}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
