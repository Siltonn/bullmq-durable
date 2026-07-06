/**
 * In-memory {@link StateStore}.
 *
 * Intended for tests and single-process setups. State lives in plain maps and
 * is deep-cloned on every read/write (via JSON) so it behaves like a real
 * store: callers cannot mutate cached results, and non-serialisable payloads
 * fail the same way they would against Redis.
 *
 * Locks are process-local, so this store does NOT provide cross-process safety.
 * Like the Redis store, state carries no TTL — it lives until reaped through
 * {@link StateStore.removeInstances} / {@link StateStore.wipeAll}.
 */

import type { InstanceState, StepState } from "../types"
import { isTerminalStatus, type TerminalStatus } from "../utils/keys"
import { cloneValue, serializeError } from "../utils/serialize"
import type {
  BeginStepInit,
  BeginStepResult,
  InitInstanceInput,
  StateStore,
} from "./state-store"

interface InstanceRecord {
  instance: InstanceState
  steps: Map<string, StepState>
  /** Epoch ms of the terminal transition (ordering key for the reaper). */
  terminalAt?: number
}

interface LockRecord {
  token: string
  expiresAt: number
}

export class MemoryStateStore implements StateStore {
  private readonly records = new Map<string, InstanceRecord>()
  private readonly locks = new Map<string, LockRecord>()

  // -- Instance lifecycle --------------------------------------------------

  async initInstance(input: InitInstanceInput): Promise<InstanceState> {
    const existing = this.records.get(input.instanceId)
    const now = Date.now()

    if (existing) {
      const status = existing.instance.status
      if (isTerminalStatus(status)) {
        return cloneValue(existing.instance)
      }
      existing.instance = {
        ...existing.instance,
        runCount: existing.instance.runCount + 1,
        ...(status !== "compensating" ? { status: "running" as const } : {}),
        updatedAt: now,
      }
      return cloneValue(existing.instance)
    }

    const instance: InstanceState = {
      id: input.instanceId,
      queueName: input.queueName,
      jobName: input.jobName,
      originalJobId: input.jobId,
      status: "running",
      input: cloneValue(input.input),
      runCount: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(input.instanceId, { instance, steps: new Map() })
    return cloneValue(instance)
  }

  async getInstance(instanceId: string): Promise<InstanceState | null> {
    const record = this.records.get(instanceId)
    return record ? cloneValue(record.instance) : null
  }

  async getInstances(instanceIds: string[]): Promise<Array<InstanceState | null>> {
    return instanceIds.map((id) => {
      const record = this.records.get(id)
      return record ? cloneValue(record.instance) : null
    })
  }

  async updateInstance(
    instanceId: string,
    patch: Partial<InstanceState>,
  ): Promise<InstanceState | null> {
    const record = this.records.get(instanceId)
    if (!record) return null
    record.instance = { ...record.instance, ...cloneValue(patch), updatedAt: Date.now() }
    if (patch.status !== undefined && isTerminalStatus(patch.status)) {
      record.terminalAt ??= Date.now()
    }
    return cloneValue(record.instance)
  }

  async completeInstance(
    instanceId: string,
    output: unknown,
    lockToken?: string,
  ): Promise<boolean> {
    const now = Date.now()
    return this.terminalTransition(instanceId, lockToken, (instance) => ({
      ...instance,
      status: "completed",
      output: cloneValue(output),
      completedAt: now,
      updatedAt: now,
    }))
  }

  async failInstance(instanceId: string, error: unknown, lockToken?: string): Promise<boolean> {
    const now = Date.now()
    return this.terminalTransition(instanceId, lockToken, (instance) => ({
      ...instance,
      status: "failed",
      error: serializeError(error),
      failedAt: now,
      updatedAt: now,
    }))
  }

  async compensationFailedInstance(
    instanceId: string,
    error: unknown,
    lockToken?: string,
  ): Promise<boolean> {
    const now = Date.now()
    return this.terminalTransition(instanceId, lockToken, (instance) => ({
      ...instance,
      status: "compensation_failed",
      error: serializeError(error),
      failedAt: now,
      updatedAt: now,
    }))
  }

  async cancelInstance(instanceId: string, lockToken?: string): Promise<boolean> {
    return this.terminalTransition(instanceId, lockToken, (instance) => ({
      ...instance,
      status: "cancelled",
      updatedAt: Date.now(),
    }))
  }

  /** Token-fenced terminal transition, mirroring the Redis TERMINAL_SCRIPT. */
  private terminalTransition(
    instanceId: string,
    lockToken: string | undefined,
    apply: (instance: InstanceState) => InstanceState,
  ): boolean {
    const record = this.records.get(instanceId)
    if (!record) return false
    if (lockToken !== undefined && lockToken !== "") {
      const lock = this.locks.get(instanceId)
      if (lock && lock.expiresAt > Date.now() && lock.token !== lockToken) return false
    }
    record.instance = apply(record.instance)
    record.terminalAt = Date.now()
    return true
  }

  // -- Steps ---------------------------------------------------------------

  async beginStep(
    instanceId: string,
    stepKey: string,
    init: BeginStepInit,
  ): Promise<BeginStepResult> {
    const record = this.records.get(instanceId)
    if (!record) return { kind: "missing" }
    if (record.instance.status === "cancelled") return { kind: "cancelled" }

    const existing = record.steps.get(stepKey)
    if (existing) return { kind: "existing", step: cloneValue(existing) }

    const seq = (record.instance.stepSeq = (record.instance.stepSeq ?? 0) + 1)
    record.instance.updatedAt = init.now
    record.steps.set(stepKey, {
      key: init.key,
      type: init.type,
      phase: init.phase,
      seq,
      status: "running",
      attempts: 1,
      startedAt: init.now,
      ...(init.nextRunAt !== undefined ? { nextRunAt: init.nextRunAt } : {}),
    })
    return { kind: "created", seq }
  }

  async getStep(instanceId: string, stepKey: string): Promise<StepState | null> {
    const step = this.records.get(instanceId)?.steps.get(stepKey)
    return step ? cloneValue(step) : null
  }

  async getSteps(instanceId: string): Promise<StepState[]> {
    const record = this.records.get(instanceId)
    if (!record) return []
    return [...record.steps.values()]
      .map((step) => cloneValue(step))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  async saveStep(instanceId: string, stepKey: string, state: StepState): Promise<void> {
    const record = this.records.get(instanceId)
    if (!record) return
    record.steps.set(stepKey, cloneValue(state))
  }

  async updateStep(instanceId: string, stepKey: string, patch: Partial<StepState>): Promise<void> {
    const record = this.records.get(instanceId)
    if (!record) return
    const current = record.steps.get(stepKey)
    if (!current) return
    record.steps.set(stepKey, { ...current, ...cloneValue(patch) })
  }

  async removeSteps(instanceId: string, stepKeys: string[]): Promise<void> {
    const record = this.records.get(instanceId)
    if (!record) return
    for (const key of stepKeys) record.steps.delete(key)
  }

  async clearInstanceFields(instanceId: string, fields: string[]): Promise<void> {
    const record = this.records.get(instanceId)
    if (!record) return
    const instance = record.instance as unknown as Record<string, unknown>
    for (const field of fields) delete instance[field]
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

  // -- Reaper / admin primitives ---------------------------------------------

  private readonly registeredQueues = new Set<string>()

  async queues(): Promise<string[]> {
    const names = new Set<string>(this.registeredQueues)
    for (const record of this.records.values()) names.add(record.instance.queueName)
    return [...names]
  }

  async registerQueue(queueName: string): Promise<void> {
    this.registeredQueues.add(queueName)
  }

  async listActive(queueName: string): Promise<string[]> {
    const out: string[] = []
    for (const [id, record] of this.records) {
      if (record.instance.queueName !== queueName) continue
      if (!isTerminalStatus(record.instance.status)) out.push(id)
    }
    return out
  }

  async listOldestTerminal(
    queueName: string,
    status: TerminalStatus,
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0) return []
    return [...this.records.entries()]
      .filter(
        ([, record]) =>
          record.instance.queueName === queueName && record.instance.status === status,
      )
      .sort(([, a], [, b]) => (a.terminalAt ?? 0) - (b.terminalAt ?? 0))
      .slice(0, limit)
      .map(([id]) => id)
  }

  async listNewestTerminal(
    queueName: string,
    status: TerminalStatus,
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0) return []
    return (await this.listOldestTerminal(queueName, status, Number.MAX_SAFE_INTEGER))
      .reverse()
      .slice(0, limit)
  }

  async listTerminalPage(
    queueName: string,
    status: TerminalStatus,
    query: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<string[]> {
    if (query.limit <= 0) return []
    const ordered = await this.listOldestTerminal(queueName, status, Number.MAX_SAFE_INTEGER)
    if (query.order === "desc") ordered.reverse()
    return ordered.slice(query.offset, query.offset + query.limit)
  }

  async countTerminal(queueName: string, status: TerminalStatus): Promise<number> {
    let count = 0
    for (const record of this.records.values()) {
      if (record.instance.queueName === queueName && record.instance.status === status) count++
    }
    return count
  }

  async removeInstances(_queueName: string, instanceIds: string[]): Promise<void> {
    for (const id of instanceIds) {
      this.records.delete(id)
      this.locks.delete(id)
    }
  }

  async wipeQueue(queueName: string): Promise<void> {
    for (const [id, record] of [...this.records]) {
      if (record.instance.queueName === queueName) {
        this.records.delete(id)
        this.locks.delete(id)
      }
    }
  }

  async wipeAll(): Promise<void> {
    this.records.clear()
    this.locks.clear()
  }

  async heldLocks(instanceIds: string[]): Promise<Set<string>> {
    const held = new Set<string>()
    const now = Date.now()
    for (const id of instanceIds) {
      const lock = this.locks.get(id)
      if (lock && lock.expiresAt > now) held.add(id)
    }
    return held
  }

  // -- Lifecycle -----------------------------------------------------------

  async close(): Promise<void> {
    this.records.clear()
    this.locks.clear()
  }
}
