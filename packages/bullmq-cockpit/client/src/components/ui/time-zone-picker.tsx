/**
 * Time-zone picker for the topbar: a compact button showing the active zone's
 * short label, opening a searchable list of every IANA zone (with Local & UTC
 * pinned on top). Picking one reformats all timestamps app-wide.
 *
 * The option rows are plain <button>s rather than HeroUI's <Listbox>: the list
 * lives inside a Popover with its own search field, and a native button's click
 * is far more dependable here than react-aria's press-based selection (which was
 * silently swallowing picks). Command-palette keyboard nav (↑/↓/Enter/Esc) on
 * the search field keeps it fully usable from the keyboard.
 */

import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@heroui/react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { supportedTimeZones, timeZoneOffset } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import { useTimeZone } from "@/lib/providers/time"

interface ZoneItem {
  id: string
  label: string
}

function buildZones(): ZoneItem[] {
  const rest = supportedTimeZones().filter((z) => z !== "UTC")
  return [
    { id: "local", label: "Local time" },
    { id: "UTC", label: "UTC" },
    ...rest.map((id) => ({ id, label: id.replace(/_/g, " ") })),
  ]
}

export function TimeZonePicker() {
  const tz = useTimeZone()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const zones = useMemo(buildZones, [])
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    const list = q
      ? zones.filter((z) => z.id.toLowerCase().includes(q) || z.label.toLowerCase().includes(q))
      : zones
    return list.slice(0, 80)
  }, [zones, query])

  // Reset the keyboard highlight to the top whenever the result set changes.
  useEffect(() => setActive(0), [query])

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active])

  const close = () => {
    setOpen(false)
    setQuery("")
  }

  const choose = (id: string) => {
    tz.setZone(id)
    close()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const z = filtered[active]
      if (z) choose(z.id)
    } else if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  return (
    <Popover
      isOpen={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setQuery("")
      }}
      placement="bottom-end"
      // Render open/close instantly. Picking a zone remounts the whole page (the
      // AppShell keys on the active zone to reformat every timestamp); when that
      // lands in the same frame as an animated close it interrupts the exit
      // animation and strands the popover on screen. No animation → nothing to
      // interrupt, and a utility picker feels snappier instant anyway.
      disableAnimation
    >
      <PopoverTrigger>
        <Button
          size="sm"
          variant="flat"
          aria-label="Select time zone"
          startContent={<CockpitIcon name="clock" width={14} />}
          className="font-mono text-xs tabular-nums"
        >
          {tz.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="border-b border-default-100 p-2">
          <Input
            autoFocus
            size="sm"
            variant="bordered"
            placeholder="Search time zone…"
            value={query}
            onValueChange={setQuery}
            onKeyDown={onKeyDown}
            isClearable
            onClear={() => setQuery("")}
            startContent={<CockpitIcon name="search" width={14} className="text-foreground-400" />}
          />
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Time zones"
          className="max-h-72 overflow-auto p-1"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-foreground-400">
              No matching zone
            </div>
          ) : (
            filtered.map((z, i) => {
              const selected = z.id === tz.zone
              return (
                <button
                  key={z.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-idx={i}
                  tabIndex={-1}
                  onClick={() => choose(z.id)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center justify-between gap-3 rounded-medium px-2.5 py-1.5 text-left text-sm transition-colors ${
                    i === active ? "bg-default-100" : ""
                  } ${selected ? "font-medium text-foreground" : "text-foreground-600"}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <CockpitIcon
                      name="check"
                      width={14}
                      className={`shrink-0 text-secondary ${selected ? "" : "invisible"}`}
                    />
                    <span className="truncate">{z.label}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground-400">
                    {timeZoneOffset(z.id)}
                  </span>
                </button>
              )
            })
          )}
        </div>
        <div className="border-t border-default-100 px-3 py-2 text-[11px] text-foreground-400">
          Times shown in {tz.zone === "local" ? "your local time" : tz.zone} ({tz.label}).
        </div>
      </PopoverContent>
    </Popover>
  )
}
