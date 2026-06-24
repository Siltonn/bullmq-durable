/**
 * Serialization helpers.
 *
 * Durable state is persisted as JSON (Redis strings / hash fields). These
 * helpers normalise errors and values so that what we store survives a
 * round-trip through a backing store and can be safely replayed later.
 */

import type { SerializedError } from "../types"

/**
 * Convert an arbitrary thrown value into a plain, JSON-serialisable shape.
 *
 * Non-`Error` throwables (strings, objects, etc.) are still captured so that a
 * failed step always records something meaningful.
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    }
    if (error.stack) serialized.stack = error.stack
    // Preserve a `code` property if present (common on Node/system errors).
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" || typeof code === "number") {
      serialized.code = code
    }
    return serialized
  }

  if (typeof error === "string") {
    return { name: "Error", message: error }
  }

  return { name: "NonError", message: safeStringify(error) }
}

/**
 * Rebuild a throwable {@link Error} from its serialized form. The original
 * prototype cannot be recovered, so this always yields a plain `Error` with the
 * recorded `name`, `message`, and `stack`.
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  if (serialized.stack) error.stack = serialized.stack
  if (serialized.code !== undefined) {
    ;(error as { code?: unknown }).code = serialized.code
  }
  return error
}

/**
 * Deep clone a value the same way a backing store would, by round-tripping
 * through JSON. This prevents callers from mutating cached step results and
 * surfaces non-serialisable payloads early (functions / symbols are dropped,
 * exactly as they would be when stored).
 *
 * `undefined` is preserved as-is (JSON has no representation for it).
 */
export function cloneValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

/** Stringify any value without throwing on cycles. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replaceCircular()) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Returns a JSON replacer that swaps already-seen objects for "[Circular]". */
function replaceCircular(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
    }
    return val
  }
}
