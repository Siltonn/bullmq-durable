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
  if (retry.maxDelayMs !== undefined) {
    delay = Math.min(delay, retry.maxDelayMs)
  }
  return delay
}
