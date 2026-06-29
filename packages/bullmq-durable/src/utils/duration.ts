/**
 * Human-friendly duration parsing.
 *
 * A {@link DurationInput} is either a raw number of milliseconds or a short
 * string such as `"10s"`, `"30m"`, `"1h"`, `"7d"`. Strings keep the public API
 * close to BullMQ's own ergonomics while staying explicit about units.
 */

/** A duration expressed as milliseconds (number) or a unit string (e.g. `"10s"`). */
export type DurationInput = number | string

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

// e.g. "10s", "1.5h", "500ms", or a bare number string interpreted as ms.
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i

// Same, but the unit is mandatory — used to tell "10s" (a delay) apart from a
// bare number like "30" (which callers usually mean as text, not milliseconds).
const UNIT_REQUIRED_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i

/**
 * Parse a {@link DurationInput} into a non-negative integer number of
 * milliseconds.
 *
 * @throws if the input is not a finite, non-negative value or is an
 * unrecognised string.
 */
export function parseDuration(input: DurationInput): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new TypeError(
        `Invalid duration: ${input}. Expected a non-negative number of milliseconds.`,
      )
    }
    return Math.round(input)
  }

  const match = DURATION_PATTERN.exec(input.trim())
  if (!match) {
    throw new TypeError(
      `Invalid duration string: "${input}". Expected a number followed by a unit (ms, s, m, h, d, w).`,
    )
  }

  const value = Number.parseFloat(match[1]!)
  const unit = (match[2] ?? "ms").toLowerCase()
  const unitMs = UNIT_TO_MS[unit]!
  const ms = Math.round(value * unitMs)
  if (!Number.isFinite(ms)) {
    throw new TypeError(`Invalid duration string: "${input}". Value is too large.`)
  }
  return ms
}

/**
 * Best-effort check that a value looks like a duration. Used to disambiguate
 * overloaded arguments (e.g. `ctx.retryLater("10s")` vs
 * `ctx.retryLater("not ready")`).
 */
export function isDurationLike(input: unknown): input is DurationInput {
  if (typeof input === "number") {
    return Number.isFinite(input) && input >= 0
  }
  if (typeof input === "string") {
    return DURATION_PATTERN.test(input.trim())
  }
  return false
}

/**
 * Whether a value is a duration string that carries an explicit unit (e.g.
 * `"10s"`, not `"30"`). Used to safely disambiguate `ctx.retryLater("10s")`
 * (a delay) from `ctx.retryLater("30")` (a reason that merely looks numeric).
 */
export function hasExplicitDurationUnit(input: unknown): boolean {
  return typeof input === "string" && UNIT_REQUIRED_PATTERN.test(input.trim())
}
