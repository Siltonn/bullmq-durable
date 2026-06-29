import { Drawer, DrawerContent, useDisclosure } from "@heroui/react"
import { useEffect, type ReactNode } from "react"
import { useTheme } from "@/lib/providers/theme"
import { useTimeZone } from "@/lib/providers/time"
import { CommandMenu } from "./command-menu"
import { Sidebar } from "./sidebar"
import { Topbar } from "./topbar"

/** The persistent dashboard chrome: sidebar (drawer on mobile) + topbar + main. */
export function AppShell({ children }: { children: ReactNode }) {
  const nav = useDisclosure()
  const command = useDisclosure()
  const { theme, toggle } = useTheme()
  // Subscribing here lets a zone change remount the page (via the keyed wrapper
  // below) so every absolute timestamp reformats at once.
  const { zone: tzZone } = useTimeZone()

  // ⌘K / Ctrl-K opens the command palette.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        command.onOpen()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [command])

  return (
    <div className="cockpit-shell flex h-dvh w-full overflow-hidden text-foreground">
      <aside className="glass-chrome hidden w-64 shrink-0 border-r border-default-200/50 lg:block">
        <Sidebar />
      </aside>

      <Drawer isOpen={nav.isOpen} onClose={nav.onClose} placement="left" size="xs">
        <DrawerContent>
          <Sidebar onNavigate={nav.onClose} />
        </DrawerContent>
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onOpenNav={nav.onOpen}
          onOpenCommand={command.onOpen}
          theme={theme}
          onToggleTheme={toggle}
        />
        <main className="flex-1 overflow-auto">
          <div key={tzZone} className="mx-auto w-full max-w-[1680px] p-5 sm:p-7 lg:px-9 lg:py-8">
            {children}
          </div>
        </main>
      </div>

      <CommandMenu isOpen={command.isOpen} onClose={command.onClose} />
    </div>
  )
}
