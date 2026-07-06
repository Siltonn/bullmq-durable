/**
 * Phase is a storage NAMESPACE, nothing more: the same step machinery runs
 * `main`, `compensation` (`onRollback`) and `failure` (`onFailure`) steps; only
 * the persisted key is prefixed so the phases can never collide. This module
 * is the single owner of those prefixes.
 */

import type { StepPhase, StepState } from "../types"

/** Namespace a step key by phase (`main` keys are stored bare). */
export function storageKeyForPhase(phase: StepPhase, key: string): string {
  if (phase === "compensation") return `__rollback__:${key}`
  if (phase === "failure") return `__failure__:${key}`
  return key
}

/** A persisted step's storage field, reconstructed from its state. */
export function storageKeyOfStep(step: Pick<StepState, "key" | "phase">): string {
  return storageKeyForPhase(step.phase ?? "main", step.key)
}
