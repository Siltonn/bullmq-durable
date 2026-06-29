/**
 * Retry-policy resolution and backoff math, shared by `ctx.step`.
 */

import type { BackoffType, RetryOptions } from "../types"
import { parseDuration } from "./duration"

/** A fully-resolved retry policy with durations normalised to milliseconds. */
export interface ResolvedRetry {
  attempts: number
  backoff: BackoffType
  delayMs: number
  maxDelayMs?: number
}

/**
 * Merge a step's retry options with the worker-level default. A step-level
 * value always wins; missing values fall back to the default, then to a sane
 * baseline (`attempts: 1`, `backoff: "fixed"`, `delay: 0`).
 */
export function resolveRetry(step?: RetryOptions, fallback?: RetryOptions): ResolvedRetry {
  const attempts = step?.attempts ?? fallback?.attempts ?? 1
  const backoff = step?.backoff ?? fallback?.backoff ?? "fixed"
  const delayInput = step?.delay ?? fallback?.delay ?? 0
  const maxDelayInput = step?.maxDelay ?? fallback?.maxDelay

  return {
    attempts: Math.max(1, Math.floor(attempts)),
    backoff,
    delayMs: parseDuration(delayInput),
    maxDelayMs: maxDelayInput !== undefined ? parseDuration(maxDelayInput) : undefined,
  }
}

/**
 * Default ceiling for exponential backoff when no explicit `maxDelay` is given.
 * Without a cap, `delay * 2 ** attempt` quickly reaches absurd (or `Infinity`)
 * values, which would push the resume job astronomically far into the future.
 */
export const DEFAULT_MAX_BACKOFF_MS = 3_600_000 // 1 hour

/**
 * Compute the delay before the next attempt.
 *
 * @param failedAttempt 1-based count of the attempt that just failed (so `1`
 *   means "the first attempt failed, compute the delay before attempt 2").
 */
export function computeBackoff(retry: ResolvedRetry, failedAttempt: number): number {
  let delay = retry.delayMs
  if (retry.backoff === "exponential") {
    delay = retry.delayMs * 2 ** Math.max(0, failedAttempt - 1)
  }
  // Exponential backoff is always capped — by the caller's `maxDelay` if set,
  // otherwise by a sane default — so the delay can never explode to Infinity.
  const cap =
    retry.maxDelayMs ?? (retry.backoff === "exponential" ? DEFAULT_MAX_BACKOFF_MS : undefined)
  if (cap !== undefined) {
    delay = Math.min(delay, cap)
  }
  return delay
}
