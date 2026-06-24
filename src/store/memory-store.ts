/**
 * In-memory {@link StateStore}.
 *
 * Intended for tests and single-process setups. State lives in plain maps and
 * is deep-cloned on every read/write (via JSON) so it behaves like a real
 * store: callers cannot mutate cached results, and non-serialisable payloads
 * fail the same way they would against Redis.
 *
 * Locks are process-local, so this store does NOT provide cross-process safety.
 */

import type { DurableLog, InstanceState, StepState } from "../types"
import { cloneValue, serializeError } from "../utils/serialize"
import type { InitInstanceInput, StateStore } from "./state-store"

interface InstanceRecord {
  instance: InstanceState
  steps: Map<string, StepState>
  logs: DurableLog[]
  /** Wall-clock expiry; the record is dropped lazily once passed. */
  expiresAt?: number
}

interface LockRecord {
  token: string
  expiresAt: number
}

const DEFAULT_MAX_LOGS = 1000

export class MemoryStateStore implements StateStore {
  private readonly records = new Map<string, InstanceRecord>()
  private readonly locks = new Map<string, LockRecord>()

  // -- Instance lifecycle --------------------------------------------------

  async initInstance(input: InitInstanceInput): Promise<InstanceState> {
    const existing = this.live(input.instanceId)
    if (existing) {
      return cloneValue(existing.instance)
    }

    const now = Date.now()
    const instance: InstanceState = {
      id: input.instanceId,
      queueName: input.queueName,
      jobName: input.jobName,
      originalJobId: input.jobId,
      status: "running",
      input: cloneValue(input.input),
      runCount: 0,
      resumeSeq: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(input.instanceId, { instance, steps: new Map(), logs: [] })
    return cloneValue(instance)
  }

  async getInstance(instanceId: string): Promise<InstanceState | null> {
    const record = this.live(instanceId)
    return record ? cloneValue(record.instance) : null
  }

  async updateInstance(
    instanceId: string,
    patch: Partial<InstanceState>,
  ): Promise<InstanceState | null> {
    const record = this.live(instanceId)
    if (!record) return null
    record.instance = { ...record.instance, ...cloneValue(patch), updatedAt: Date.now() }
    return cloneValue(record.instance)
  }

  async completeInstance(instanceId: string, output: unknown): Promise<void> {
    const record = this.live(instanceId)
    if (!record) return
    const now = Date.now()
    record.instance = {
      ...record.instance,
      status: "completed",
      output: cloneValue(output),
      completedAt: now,
      updatedAt: now,
    }
  }

  async failInstance(instanceId: string, error: unknown): Promise<void> {
    const record = this.live(instanceId)
    if (!record) return
    const now = Date.now()
    record.instance = {
      ...record.instance,
      status: "failed",
      error: serializeError(error),
      failedAt: now,
      updatedAt: now,
    }
  }

  async cancelInstance(instanceId: string): Promise<void> {
    const record = this.live(instanceId)
    if (!record) return
    record.instance = { ...record.instance, status: "cancelled", updatedAt: Date.now() }
  }

  async nextResumeSeq(instanceId: string): Promise<number> {
    const record = this.live(instanceId)
    if (!record) return 0
    record.instance.resumeSeq += 1
    record.instance.updatedAt = Date.now()
    return record.instance.resumeSeq
  }

  // -- Steps ---------------------------------------------------------------

  async getStep(instanceId: string, stepKey: string): Promise<StepState | null> {
    const record = this.live(instanceId)
    const step = record?.steps.get(stepKey)
    return step ? cloneValue(step) : null
  }

  async getSteps(instanceId: string): Promise<StepState[]> {
    const record = this.live(instanceId)
    if (!record) return []
    return [...record.steps.values()].map((step) => cloneValue(step))
  }

  async saveStep(instanceId: string, stepKey: string, state: StepState): Promise<void> {
    const record = this.live(instanceId)
    if (!record) return
    record.steps.set(stepKey, cloneValue(state))
  }

  async updateStep(instanceId: string, stepKey: string, patch: Partial<StepState>): Promise<void> {
    const record = this.live(instanceId)
    if (!record) return
    const current = record.steps.get(stepKey)
    if (!current) return
    record.steps.set(stepKey, { ...current, ...cloneValue(patch) })
  }

  // -- Logs ----------------------------------------------------------------

  async appendLog(
    instanceId: string,
    log: DurableLog,
    maxLogs: number = DEFAULT_MAX_LOGS,
  ): Promise<void> {
    const record = this.live(instanceId)
    if (!record) return
    record.logs.push(cloneValue(log))
    if (record.logs.length > maxLogs) {
      record.logs.splice(0, record.logs.length - maxLogs)
    }
  }

  async getLogs(instanceId: string): Promise<DurableLog[]> {
    const record = this.live(instanceId)
    if (!record) return []
    return record.logs.map((log) => cloneValue(log))
  }

  // -- Locking -------------------------------------------------------------

  async acquireLock(instanceId: string, token: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(instanceId)
    const now = Date.now()
    if (existing && existing.expiresAt > now && existing.token !== token) {
      return false
    }
    this.locks.set(instanceId, { token, expiresAt: now + ttlMs })
    return true
  }

  async renewLock(instanceId: string, token: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(instanceId)
    const now = Date.now()
    if (!existing || existing.token !== token || existing.expiresAt <= now) {
      return false
    }
    existing.expiresAt = now + ttlMs
    return true
  }

  async releaseLock(instanceId: string, token: string): Promise<void> {
    const existing = this.locks.get(instanceId)
    if (existing && existing.token === token) {
      this.locks.delete(instanceId)
    }
  }

  // -- Retention -----------------------------------------------------------

  async expireInstance(instanceId: string, ttlMs: number): Promise<void> {
    const record = this.records.get(instanceId)
    if (!record) return
    record.expiresAt = Date.now() + ttlMs
  }

  // -- Lifecycle -----------------------------------------------------------

  async close(): Promise<void> {
    this.records.clear()
    this.locks.clear()
  }

  // -- Internals -----------------------------------------------------------

  /** Resolve a record, dropping it first if its retention TTL has elapsed. */
  private live(instanceId: string): InstanceRecord | undefined {
    const record = this.records.get(instanceId)
    if (!record) return undefined
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      this.records.delete(instanceId)
      return undefined
    }
    return record
  }
}
