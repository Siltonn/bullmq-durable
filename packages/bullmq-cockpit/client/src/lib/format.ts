/** Human-friendly formatting for timestamps, durations, and counts. */

const numberFmt = new Intl.NumberFormat("en-US")

export function formatNumber(value: number): string {
  return numberFmt.format(value)
}

// ---------------------------------------------------------------------------
// Time zone — absolute timestamps render in the viewer's local zone by default
// (intuitive), but every formatted datetime is *labelled* with its zone so it's
// never ambiguous, and the viewer can pick any IANA zone (handy for distributed
// teams / matching server logs). `"local"` is the sentinel for the browser zone;
// anything else is an IANA id like "America/New_York" or "UTC". The active zone
// is a module-level setting driven by the TimeZoneProvider; see lib/time.tsx.
// ---------------------------------------------------------------------------

/** The chosen zone: `"local"`, `"UTC"`, or any IANA id (e.g. "Europe/London"). */
export type TimeZone = string

const TZ_STORAGE_KEY = "bullmq-cockpit:timezone"

let zone: TimeZone =
  (typeof localStorage !== "undefined" && localStorage.getItem(TZ_STORAGE_KEY)) || "local"

/** The Intl `timeZone` value for the active zone (undefined ⇒ browser local). */
function intlZone(z: TimeZone = zone): string | undefined {
  return z === "local" ? undefined : z
}

export function getTimeZone(): TimeZone {
  return zone
}

export function setTimeZone(next: TimeZone): void {
  zone = next
  try {
    localStorage.setItem(TZ_STORAGE_KEY, next)
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}

/** Short label of a zone for the current time, e.g. "PDT" / "UTC" / "GMT+5:30". */
export function timeZoneLabel(z: TimeZone = zone, now = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, {
      timeZone: intlZone(z),
      timeZoneName: "short",
    })
      .formatToParts(new Date(now))
      .find((p) => p.type === "timeZoneName")
    if (part?.value) return part.value
  } catch {
    // invalid zone — fall through
  }
  return z === "local" ? "Local" : z
}

/** GMT offset label of a zone, e.g. "GMT-7" / "GMT+5:30". Empty if unknown. */
export function timeZoneOffset(z: TimeZone, now = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: intlZone(z),
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date(now))
      .find((p) => p.type === "timeZoneName")
    return part?.value ?? ""
  } catch {
    return ""
  }
}

const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
]

let cachedZones: string[] | null = null

/** Every IANA zone the runtime knows (with a curated fallback). */
export function supportedTimeZones(): string[] {
  if (cachedZones) return cachedZones
  let list: string[] = []
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf
    if (typeof supported === "function") list = supported("timeZone")
  } catch {
    // not supported — use the fallback
  }
  const set = new Set(list.length > 0 ? list : FALLBACK_ZONES)
  set.add("UTC")
  cachedZones = [...set].sort()
  return cachedZones
}

/** Compact a large count: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function formatCompact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** A duration in ms → "421ms", "1.2s", "3m 12s", "2h 5m". */
export function formatDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) {
    const seconds = ms / 1000
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins ? `${hours}h ${mins}m` : `${hours}h`
}

const UNITS: Array<[limit: number, divisor: number, suffix: string]> = [
  [60_000, 1000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [Number.POSITIVE_INFINITY, 86_400_000, "d"],
]

function relative(deltaMs: number): string {
  const abs = Math.abs(deltaMs)
  if (abs < 1000) return "just now"
  for (const [limit, divisor, suffix] of UNITS) {
    if (abs < limit) return `${Math.round(abs / divisor)}${suffix}`
  }
  return ""
}

/** "3m ago" / "in 8s" relative to now. */
export function formatRelative(timestamp?: number, now = Date.now()): string {
  if (timestamp === undefined) return "—"
  const delta = timestamp - now
  if (Math.abs(delta) < 1000) return "just now"
  return delta < 0 ? `${relative(delta)} ago` : `in ${relative(delta)}`
}

/** A countdown to a future time: "in 8s", or "overdue 3s" once it passes. */
export function formatCountdown(targetTs?: number, now = Date.now()): string {
  if (targetTs === undefined) return "—"
  const delta = targetTs - now
  if (delta <= 0) return `overdue ${relative(delta)}`
  return `in ${relative(delta)}`
}

export function formatDateTime(timestamp?: number): string {
  if (timestamp === undefined) return "—"
  // Render in the chosen zone and always show its short name so the displayed
  // time is never ambiguous (e.g. "… 9:31:28 AM PDT" / "… UTC"). A bad zone id
  // falls back to local rather than throwing.
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }
  try {
    return new Date(timestamp).toLocaleString(undefined, { ...opts, timeZone: intlZone() })
  } catch {
    return new Date(timestamp).toLocaleString(undefined, opts)
  }
}

export function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Bytes → "1.4 MB". */
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

/** Pretty-print any value as JSON for the viewer / copy buttons. */
export function toJson(value: unknown): string {
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
