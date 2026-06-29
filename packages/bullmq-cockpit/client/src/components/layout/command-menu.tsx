/** A small ⌘K command palette for jumping between sections. */

import { Kbd, Modal, ModalContent } from "@heroui/react"
import { useNavigate } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useCockpitConfig } from "@/lib/providers/config"
import { CockpitIcon, type IconName } from "@/lib/icons"

interface Command {
  to: string
  label: string
  icon: IconName
  keywords: string
}

export function CommandMenu({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const config = useCockpitConfig()
  const navigate = useNavigate()
  const [query, setQuery] = useState("")

  const commands = useMemo<Command[]>(
    () => [
      { to: "/", label: "Overview", icon: "dashboard", keywords: "home dashboard" },
      { to: "/queues", label: "Queues", icon: "queues", keywords: "queue" },
      { to: "/jobs", label: "Jobs", icon: "jobs", keywords: "job" },
      {
        to: "/flows",
        label: "Flows",
        icon: "flows",
        keywords: "flow parent child dag tree dependency",
      },
      {
        to: "/schedulers",
        label: "Schedulers",
        icon: "schedulers",
        keywords: "scheduler repeatable cron interval",
      },
      { to: "/metrics", label: "Metrics", icon: "metrics", keywords: "metrics throughput chart" },
      ...(config.durableEnabled
        ? [
            {
              to: "/durable",
              label: "Durable instances",
              icon: "durable" as IconName,
              keywords: "durable workflow instance step",
            },
          ]
        : []),
      {
        to: "/alerts",
        label: "Alerts",
        icon: "alerts",
        keywords: "alert rule notify slack webhook firing",
      },
      { to: "/health", label: "Health & stuck", icon: "health", keywords: "health stuck" },
    ],
    [config.durableEnabled],
  )

  const filtered = commands.filter((cmd) => {
    const q = query.toLowerCase().trim()
    if (!q) return true
    return `${cmd.label} ${cmd.keywords}`.toLowerCase().includes(q)
  })

  const go = (to: string) => {
    void navigate({ to })
    onClose()
    setQuery("")
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      placement="top"
      hideCloseButton
      classNames={{ base: "mt-[12vh]" }}
    >
      <ModalContent>
        <div className="flex items-center gap-2 border-b border-default-100 px-4 py-3">
          <CockpitIcon name="search" width={18} className="text-foreground-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) go(filtered[0].to)
            }}
            placeholder="Jump to…"
            className="flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-foreground-400"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul className="max-h-80 overflow-auto p-2">
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-foreground-400">No matches</li>
          )}
          {filtered.map((cmd) => (
            <li key={cmd.to}>
              <button
                type="button"
                onClick={() => go(cmd.to)}
                className="flex w-full items-center gap-3 rounded-medium px-3 py-2 text-left text-sm text-foreground-600 transition-colors hover:bg-default-100"
              >
                <CockpitIcon name={cmd.icon} width={18} className="text-foreground-400" />
                {cmd.label}
              </button>
            </li>
          ))}
        </ul>
      </ModalContent>
    </Modal>
  )
}
