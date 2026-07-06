/**
 * One-shot deprecation warnings for 0.1.x options that 0.2.0 accepts but no
 * longer uses. Each key warns at most once per process, so a hot path can call
 * these unconditionally.
 */

const warned = new Set<string>()

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`bullmq-durable: ${message}`)
}

/** Test hook. */
export function resetDeprecationWarnings(): void {
  warned.clear()
}
