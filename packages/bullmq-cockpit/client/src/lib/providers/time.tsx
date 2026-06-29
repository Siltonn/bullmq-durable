/**
 * Time-zone preference for absolute timestamps. Driving it through a context (and
 * remounting the page on change, see AppShell) means picking a new zone reformats
 * every `formatDateTime` output at once. The active zone lives in `lib/format.ts`
 * so pure formatters can read it without a hook.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { getTimeZone, setTimeZone, timeZoneLabel, type TimeZone } from "@/lib/format"

interface TimeZoneContext {
  /** `"local"`, `"UTC"`, or any IANA id. */
  zone: TimeZone
  /** Short label of the active zone, e.g. "PDT" / "UTC" / "GMT+5:30". */
  label: string
  setZone: (zone: TimeZone) => void
}

const Ctx = createContext<TimeZoneContext | null>(null)

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const [zone, setZoneState] = useState<TimeZone>(() => getTimeZone())

  const setZone = useCallback((next: TimeZone) => {
    setTimeZone(next)
    setZoneState(next)
  }, [])

  const value = useMemo<TimeZoneContext>(
    () => ({ zone, label: timeZoneLabel(zone), setZone }),
    [zone, setZone],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTimeZone(): TimeZoneContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useTimeZone must be used within a TimeZoneProvider")
  return ctx
}
