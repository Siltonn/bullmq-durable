/**
 * Retry-policy resolution and backoff math, shared by `ctx.step`.
 *
 * The public {@link RetryOptions} shape mirrors BullMQ's `attempts`/`backoff`
 * vocabulary (including `jitter`); this module normalises every accepted form —
 * including the deprecated 0.1.x flat shape — into one {@link ResolvedRetry}.
 */

import type { BackoffType, RetryOptions, StepBackoff } from "../types"
import { type DurationInput, parseDuration } from "./duration"

/** A fully-resolved retry policy with durations normalised to milliseconds. */
export interface ResolvedRetry {
  attempts: number
  type: BackoffType
  delayMs: number
  /** Randomisation fraction (0..1). `0` disables jitter. */
  jitter: number
  maxDelayMs?: number
}

/**
 * Default ceiling for exponential backoff when no explicit `maxDelay` is given.
 * Without a cap, `delay * 2 ** attempt` quickly reaches absurd (or `Infinity`)
 * values, which would push the delayed job astronomically far into the future.
 */
export const DEFAULT_MAX_BACKOFF_MS = 3_600_000 // 1 hour

interface NormalizedBackoff {
  type?: BackoffType
  delayMs?: number
  jitter?: number
  maxDelayMs?: number
}

/**
 * Normalise one `backoff` value (any accepted form) into its parts. The
 * deprecated bare `"fixed"`/`"exponential"` string carries no delay of its own —
 * the 0.1.x flat `delay`/`maxDelay` fields supply it via {@link resolveRetry}.
 */
function normalizeBackoff(backoff: StepBackoff | undefined): NormalizedBackoff {
  if (backoff === undefined) return {}
  if (typeof backoff === "number") return { type: "fixed", delayMs: parseDuration(backoff) }
  if (typeof backoff === "string") {
    if (backoff === "fixed" || backoff === "exponential") return { type: backoff }
    return { type: "fixed", delayMs: parseDuration(backoff) }
  }
  return {
    type: backoff.type,
    delayMs: backoff.delay !== undefined ? parseDuration(backoff.delay) : undefined,
    jitter: backoff.jitter,
    maxDelayMs: backoff.maxDelay !== undefined ? parseDuration(backoff.maxDelay) : undefined,
  }
}

/**
 * Merge a step's retry options with the worker-level default. A step-level
 * value always wins; missing values fall back to the default, then to a sane
 * baseline (`attempts: 1`, fixed, no delay). Field-wise fallback happens on the
 * normalised parts, so a step may e.g. override only the delay while inheriting
 * the worker default's exponential type.
 */
export function resolveRetry(step?: RetryOptions, fallback?: RetryOptions): ResolvedRetry {
  const s = normalizeBackoff(step?.backoff)
  const f = normalizeBackoff(fallback?.backoff)

  // Deprecated 0.1.x flat fields participate as the lowest-priority source on
  // their own level (a step's flat `delay` still beats the fallback entirely).
  const legacyDelay = (o?: RetryOptions): number | undefined =>
    o?.delay !== undefined ? parseDuration(o.delay as DurationInput) : undefined
  const legacyMax = (o?: RetryOptions): number | undefined =>
    o?.maxDelay !== undefined ? parseDuration(o.maxDelay as DurationInput) : undefined

  const attempts = step?.attempts ?? fallback?.attempts ?? 1
  const type = s.type ?? f.type ?? "fixed"
  const delayMs = s.delayMs ?? legacyDelay(step) ?? f.delayMs ?? legacyDelay(fallback) ?? 0
  const jitter = s.jitter ?? f.jitter ?? 0
  const maxDelayMs = s.maxDelayMs ?? legacyMax(step) ?? f.maxDelayMs ?? legacyMax(fallback)

  return {
    attempts: Math.max(1, Math.floor(attempts)),
    type,
    delayMs,
    jitter: Math.min(1, Math.max(0, jitter)),
    maxDelayMs,
  }
}

/**
 * Compute the delay before the next attempt. Mirrors BullMQ's built-in
 * strategies exactly (fixed / exponential, uniform jitter over
 * `[base*(1-jitter), base)`), with the durable extension that exponential
 * growth is always capped — by `maxDelay` if set, else 1 hour.
 *
 * @param failedAttempt 1-based count of the attempt that just failed (so `1`
 *   means "the first attempt failed, compute the delay before attempt 2").
 */
export function computeBackoff(retry: ResolvedRetry, failedAttempt: number): number {
  let base = retry.delayMs
  if (retry.type === "exponential") {
    base = Math.round(retry.delayMs * 2 ** Math.max(0, failedAttempt - 1))
  }
  // Cap BEFORE jitter so the final delay can never exceed maxDelay.
  const cap =
    retry.maxDelayMs ?? (retry.type === "exponential" ? DEFAULT_MAX_BACKOFF_MS : undefined)
  if (cap !== undefined) base = Math.min(base, cap)

  if (retry.jitter > 0) {
    const min = base * (1 - retry.jitter)
    return Math.floor(Math.random() * base * retry.jitter + min)
  }
  return base
}
