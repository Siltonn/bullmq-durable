/**
 * Pure time-domain model for the durable waterfall.
 *
 * No JSX — safe to import from non-React contexts and test without a DOM.
 */

import type { DurableEvent, DurableInstanceDetail, DurableStep } from "@shared/dto"
import { formatDuration } from "@/lib/format"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RowBase {
  id: string
  depth: number
  /** Ancestor columns: whether a vertical guide continues at each one. */
  guides: boolean[]
  /** Whether this row is the last child of its parent (└ vs ├). */
  isLast: boolean
}

export type Row =
  | (RowBase & { kind: "instance" })
  | (RowBase & { kind: "step"; step: DurableStep; expandable: boolean; expanded: boolean })
  | (RowBase & { kind: "event"; event: DurableEvent })

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const clampPct = (n: number) => Math.min(100, Math.max(0, n))

/** When a step's bar ends: completion, failure, the sleep deadline, or "now". */
export function stepEnd(step: DurableStep, now: number): number {
  if (step.completedAt) return step.completedAt
  if (step.failedAt) return step.failedAt
  if (step.type === "sleep" && step.sleepUntil) return step.sleepUntil
  if (step.status === "running" || step.status === "sleeping") return now
  return (step.startedAt ?? now) + (step.durationMs ?? 0)
}

/** Concise relative offset for axis ticks: 0s · 420ms · 1.6s · 3m 5s. */
export function formatAxisOffset(ms: number): string {
  if (ms < 1) return "0s"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`
  return formatDuration(ms)
}

// ---------------------------------------------------------------------------
// Time-domain model builder
// ---------------------------------------------------------------------------

export interface WaterfallModel {
  now: number
  steps: DurableStep[]
  t0: number
  t1: number
  span: number
  pct: (t: number) => number
  byStep: Map<string, DurableEvent[]>
  rootEvents: DurableEvent[]
}

/**
 * Build the time-domain model from raw instance + events data.
 * Pure function — no side effects, no React hooks.
 */
export function buildWaterfallModel(
  instance: DurableInstanceDetail,
  events: DurableEvent[] | undefined,
  now: number,
): WaterfallModel {
  const steps = instance.steps

  // Time domain spanning the whole run.
  const starts: number[] = [instance.startedAt ?? instance.createdAt]
  const ends: number[] = [instance.completedAt ?? instance.failedAt ?? now]
  for (const s of steps) {
    if (s.startedAt) starts.push(s.startedAt)
    ends.push(stepEnd(s, now))
  }
  for (const e of events ?? []) {
    starts.push(e.timestamp)
    ends.push(e.timestamp)
  }
  const t0 = Math.min(...starts)
  const t1 = Math.max(...ends)
  const span = Math.max(t1 - t0, 1)
  const pct = (t: number) => clampPct(((t - t0) / span) * 100)

  // Nest interesting events (logs / retries / errors) under the step that was
  // running at their timestamp; orphans bubble up to the root.
  const byStep = new Map<string, DurableEvent[]>()
  const rootEvents: DurableEvent[] = []
  const stepFor = (e: DurableEvent): DurableStep | undefined => {
    if (e.stepKey) return steps.find((s) => s.key === e.stepKey)
    return steps.find(
      (s) => s.startedAt && e.timestamp >= s.startedAt && e.timestamp <= stepEnd(s, now),
    )
  }
  for (const e of events ?? []) {
    if (e.type !== "log" && e.type !== "retry" && e.type !== "error") continue
    const owner = stepFor(e)
    if (owner) {
      const list = byStep.get(owner.key) ?? []
      list.push(e)
      byStep.set(owner.key, list)
    } else {
      rootEvents.push(e)
    }
  }

  return { now, steps, t0, t1, span, pct, byStep, rootEvents }
}
