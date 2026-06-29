/**
 * Value previews and small formatting helpers used when projecting stored state
 * onto the wire. List endpoints must not ship multi-megabyte step results, so
 * large values are summarised to a short, safe placeholder.
 */

const DEFAULT_MAX_PREVIEW_BYTES = 2048

/**
 * Return a compact preview of an arbitrary value:
 *  - small JSON values pass through untouched
 *  - anything whose JSON encoding exceeds `maxBytes` becomes a short string
 *    marker noting the original type and size
 *
 * The goal is a value that is always cheap to serialise and render, while the
 * full value remains available from the corresponding *detail* endpoint.
 */
export function previewValue(value: unknown, maxBytes = DEFAULT_MAX_PREVIEW_BYTES): unknown {
  if (value === undefined || value === null) return value
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return "[unserialisable]"
  }
  if (json === undefined) return undefined
  if (json.length <= maxBytes) return value

  const kind = Array.isArray(value) ? `array(${value.length})` : typeof value
  return `[${kind}, ${json.length} bytes — open detail to view]`
}

/**
 * Compute a duration between two epoch-millis timestamps, tolerating missing or
 * out-of-order inputs (returns `undefined` rather than a negative number).
 */
export function durationBetween(start?: number, end?: number): number | undefined {
  if (start === undefined || end === undefined) return undefined
  const delta = end - start
  return delta >= 0 ? delta : undefined
}
