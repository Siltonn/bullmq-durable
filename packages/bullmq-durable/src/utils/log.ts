/**
 * Durable log-line encoding.
 *
 * Every `ctx.log` call (and runtime failure-path event) is stored as ONE JSON
 * line in the BullMQ job's own log list (`job.log()`), tagged `"$durable": 1`
 * so readers can tell durable lines apart from foreign `job.log()` calls. The
 * job's `keepLogs` option bounds the list natively; the lines are removed
 * together with the job.
 *
 * Field names deliberately match the public {@link DurableLogEntry} type (and
 * the pre-0.2 `DurableLog` shape: `message` / `timestamp` / `meta`), so the
 * wire format, the API and old callers all read the same names.
 */

import type { DurableLogEntry } from "../types"

/** Wire discriminator + schema version. */
export const DURABLE_LOG_MARKER = "$durable"
export const DURABLE_LOG_VERSION = 1

/**
 * Serialised entries larger than this have their `meta` replaced with a
 * truncation marker. Keeps a single oversized `ctx.log(meta)` from dominating
 * the job-log list's memory.
 */
export const MAX_LOG_ENTRY_BYTES = 8 * 1024

/** Serialise an entry to its wire line, applying the oversize guard. */
export function serializeLogEntry(entry: DurableLogEntry): string {
  const wire = { [DURABLE_LOG_MARKER]: DURABLE_LOG_VERSION, ...entry }
  let line = JSON.stringify(wire)
  if (line.length > MAX_LOG_ENTRY_BYTES && entry.meta !== undefined) {
    line = JSON.stringify({ ...wire, meta: { $truncated: true } })
  }
  return line
}

/**
 * Parse one job-log line. Durable lines (`{"$durable":1,...}`) come back as
 * their structured entry; anything else — foreign `job.log()` calls, corrupt
 * lines — is wrapped as `{ kind: "raw", message: line }` so callers never have
 * to special-case them.
 */
export function parseLogLine(line: string): DurableLogEntry {
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed[DURABLE_LOG_MARKER] === DURABLE_LOG_VERSION) {
        const { [DURABLE_LOG_MARKER]: _marker, ...entry } = parsed
        return entry as unknown as DurableLogEntry
      }
    } catch {
      // fall through to raw
    }
  }
  return { kind: "raw", message: line, timestamp: 0 }
}

/** Parse a full job-log listing (as returned by `queue.getJobLogs`). */
export function parseJobLogs(lines: string[]): DurableLogEntry[] {
  return lines.map(parseLogLine)
}
