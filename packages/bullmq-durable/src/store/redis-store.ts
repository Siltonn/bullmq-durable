/**
 * Redis-backed {@link StateStore} — the default, production implementation.
 *
 * Layout (see {@link import("../utils/keys")}):
 *  - `{prefix}:instance:{id}`  Hash   — instance fields
 *  - `{prefix}:steps:{id}`     Hash   — stepKey -> JSON(StepState)
 *  - `{prefix}:logs:{id}`      List   — bounded, chronological
 *  - `{prefix}:lock:{id}`      String — advisory instance lock
 *
 * Durability depends entirely on how the underlying Redis is configured. See
 * the README's "Redis persistence" section before using this for
 * business-critical state.
 */

import type { ConnectionOptions } from "bullmq"
import { Redis, type RedisOptions } from "ioredis"
import type { DurableLog, InstanceState, InstanceStatus, StepState } from "../types"
import {
  activeIndexKey,
  DEFAULT_DURABLE_PREFIX,
  INDEX_NEVER_EXPIRES,
  instanceKey,
  lockKey,
  logsKey,
  stepsKey,
  terminalIndexKey,
  type TerminalStatus,
} from "../utils/keys"
import { cloneValue, serializeError } from "../utils/serialize"
import type { InitInstanceInput, StateStore } from "./state-store"

export interface RedisStateStoreOptions {
  /** A BullMQ-compatible connection: ioredis options or an existing client. */
  connection: ConnectionOptions
  /** Redis key prefix for durable state. Defaults to `"bullmq-durable"`. */
  prefix?: string
}

const DEFAULT_MAX_LOGS = 1000

// Atomic create-if-absent. Returns 1 when the instance was created, 0 if it
// already existed (so the caller reads the stored state instead).
//
// KEYS: [1] instance hash, [2] idx:active, [3] idx:done:completed,
//       [4] idx:done:failed, [5] idx:done:cancelled, [6] idx:done:compensation_failed.
// ARGV: [1] instance id, [2..] HSET field pairs.
// New instances start `running` (non-terminal), so they join the active set in
// the same atomic step as the hash write — the index can never drift from state.
// Creating a fresh instance also clears any stale terminal-index entry left by a
// PRIOR run under the same id (a reused BullMQ job id whose done-bucket entry
// outlived its expired hash), so a reused id is never double-counted (a phantom
// in a done bucket while the new run is active).
const INIT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[5], ARGV[1])
redis.call('ZREM', KEYS[6], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`

// Update-if-present. Returns 1 when the instance existed and was patched, 0 if
// it was absent — so a stray update (e.g. cancelling a job before its first
// tick) cannot conjure a half-populated "zombie" instance. This mirrors the
// in-memory store, which no-ops on a missing record.
//
// KEYS: [1] instance hash, [2] idx:active, [3] idx:done:completed,
//       [4] idx:done:failed, [5] idx:done:cancelled, [6] idx:done:compensation_failed.
// ARGV: [1] instance id, [2] new status ('' when the patch doesn't change it),
//       [3] terminal score (INDEX_NEVER_EXPIRES — re-scored later by retention),
//       [4..] HSET field pairs.
// The index is maintained ONLY on a real status transition, atomically with the
// patch: terminal statuses leave the active set and enter their done-bucket;
// running/yielded/compensating stays active (SADD is idempotent, covering the
// backfill case where an in-flight instance wasn't yet indexed).
const UPDATE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local old = redis.call('HGET', KEYS[1], 'status')
redis.call('HSET', KEYS[1], unpack(ARGV, 4))
local new = ARGV[2]
if new ~= '' and new ~= old then
  if new == 'completed' then
    redis.call('SREM', KEYS[2], ARGV[1]); redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
  elseif new == 'failed' then
    redis.call('SREM', KEYS[2], ARGV[1]); redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
  elseif new == 'cancelled' then
    redis.call('SREM', KEYS[2], ARGV[1]); redis.call('ZADD', KEYS[5], ARGV[3], ARGV[1])
  elseif new == 'compensation_failed' then
    redis.call('SREM', KEYS[2], ARGV[1]); redis.call('ZADD', KEYS[6], ARGV[3], ARGV[1])
  else
    redis.call('SADD', KEYS[2], ARGV[1])
  end
end
return 1
`

// Atomic terminal transition WITH retention, in one round-trip: flip the status,
// move the id out of the active set into its done-bucket scored by real expiry
// (now + ttl), prune already-expired ids from that bucket, and PEXPIRE the data
// keys. Folding the transition and retention into one script means a crash can
// never leave a terminal instance un-expired or its index entry stuck at a
// never-expire sentinel — the failure mode of doing the transition and retention
// as two separate calls.
//
// KEYS: [1] instance, [2] steps, [3] logs, [4] idx:active, [5] idx:done:<status>.
// ARGV: [1] instance id, [2] ttlMs, [3] expiry score (now+ttlMs), [4] now (prune
//       ceiling), [5..] HSET field pairs.
const TERMINAL_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV, 5))
redis.call('SREM', KEYS[4], ARGV[1])
redis.call('ZADD', KEYS[5], ARGV[3], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[3], ARGV[2])
return 1
`

// Apply retention: expire the instance's data keys, re-score its terminal index
// entry to its real expiry epoch (now + ttl), AND prune the bucket of any ids
// whose expiry has already passed. Doing all three in one script keeps the index
// in step with the TTL and bounded WITHOUT relying on a reader to prune it — so a
// library-only deployment (no dashboard) never leaks index entries.
//
// KEYS: [1] instance, [2] steps, [3] logs, [4] done:completed, [5] done:failed,
//       [6] done:cancelled, [7] done:compensation_failed.
// ARGV: [1] ttlMs, [2] expiry score (now + ttlMs), [3] instance id, [4] now.
const EXPIRE_SCRIPT = `
redis.call('PEXPIRE', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[3], ARGV[1])
local s = redis.call('HGET', KEYS[1], 'status')
if s == 'completed' then
  redis.call('ZADD', KEYS[4], ARGV[2], ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[4])
elseif s == 'failed' then
  redis.call('ZADD', KEYS[5], ARGV[2], ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[4])
elseif s == 'cancelled' then
  redis.call('ZADD', KEYS[6], ARGV[2], ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', ARGV[4])
elseif s == 'compensation_failed' then
  redis.call('ZADD', KEYS[7], ARGV[2], ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[7], '-inf', ARGV[4])
end
return 1
`

// Acquire or re-enter a lock: succeeds if the lock is free or already ours.
const LOCK_ACQUIRE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur == false or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`

const LOCK_RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

const LOCK_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export class RedisStateStore implements StateStore {
  private readonly redis: Redis
  private readonly prefix: string

  constructor(options: RedisStateStoreOptions) {
    this.prefix = options.prefix ?? DEFAULT_DURABLE_PREFIX
    this.redis = createClient(options.connection)

    // Register the Lua helpers as cached, named commands. The key counts must
    // match each script's KEYS arity (see the script comments above).
    this.redis.defineCommand("durableInit", { numberOfKeys: 6, lua: INIT_SCRIPT })
    this.redis.defineCommand("durableUpdate", { numberOfKeys: 6, lua: UPDATE_SCRIPT })
    this.redis.defineCommand("durableTerminal", { numberOfKeys: 5, lua: TERMINAL_SCRIPT })
    this.redis.defineCommand("durableExpire", { numberOfKeys: 7, lua: EXPIRE_SCRIPT })
    this.redis.defineCommand("durableLockAcquire", { numberOfKeys: 1, lua: LOCK_ACQUIRE_SCRIPT })
    this.redis.defineCommand("durableLockRenew", { numberOfKeys: 1, lua: LOCK_RENEW_SCRIPT })
    this.redis.defineCommand("durableLockRelease", { numberOfKeys: 1, lua: LOCK_RELEASE_SCRIPT })
  }

  // -- Instance lifecycle --------------------------------------------------

  async initInstance(input: InitInstanceInput): Promise<InstanceState> {
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

    const created = (await this.cmd("durableInit")(
      this.instanceKey(input.instanceId),
      this.activeKey(),
      this.terminalKey("completed"),
      this.terminalKey("failed"),
      this.terminalKey("cancelled"),
      this.terminalKey("compensation_failed"),
      input.instanceId,
      ...encodeInstanceFields(instance),
    )) as number

    if (created === 1) return instance
    // Lost the race / already existed: return what is stored.
    const stored = await this.getInstance(input.instanceId)
    return stored ?? instance
  }

  async getInstance(instanceId: string): Promise<InstanceState | null> {
    const hash = await this.redis.hgetall(this.instanceKey(instanceId))
    if (!hash || Object.keys(hash).length === 0) return null
    return parseInstance(hash)
  }

  async updateInstance(
    instanceId: string,
    patch: Partial<InstanceState>,
  ): Promise<InstanceState | null> {
    const fields = encodeInstanceFields({ ...patch, updatedAt: patch.updatedAt ?? Date.now() })
    if (fields.length === 0) return this.getInstance(instanceId)

    // Index keys + transition control args precede the HSET field pairs. A patch
    // that doesn't set `status` passes "" so the Lua skips all index work — the
    // common non-transition update (runCount / resumeSeq / output) costs nothing
    // extra.
    const updated = (await this.cmd("durableUpdate")(
      this.instanceKey(instanceId),
      this.activeKey(),
      this.terminalKey("completed"),
      this.terminalKey("failed"),
      this.terminalKey("cancelled"),
      this.terminalKey("compensation_failed"),
      instanceId,
      patch.status ?? "",
      String(INDEX_NEVER_EXPIRES),
      ...fields,
    )) as number
    if (updated === 0) return null
    return this.getInstance(instanceId)
  }

  async completeInstance(instanceId: string, output: unknown, ttlMs?: number): Promise<void> {
    const now = Date.now()
    await this.terminalTransition(
      instanceId,
      "completed",
      { status: "completed", output, completedAt: now, updatedAt: now },
      ttlMs,
    )
  }

  async failInstance(instanceId: string, error: unknown, ttlMs?: number): Promise<void> {
    const now = Date.now()
    await this.terminalTransition(
      instanceId,
      "failed",
      { status: "failed", error: serializeError(error), failedAt: now, updatedAt: now },
      ttlMs,
    )
  }

  async compensationFailedInstance(
    instanceId: string,
    error: unknown,
    ttlMs?: number,
  ): Promise<void> {
    const now = Date.now()
    await this.terminalTransition(
      instanceId,
      "compensation_failed",
      { status: "compensation_failed", error: serializeError(error), failedAt: now, updatedAt: now },
      ttlMs,
    )
  }

  async cancelInstance(instanceId: string, ttlMs?: number): Promise<void> {
    await this.terminalTransition(
      instanceId,
      "cancelled",
      { status: "cancelled", updatedAt: Date.now() },
      ttlMs,
    )
  }

  /**
   * Move an instance to a terminal status. When `ttlMs` is given (the runtime
   * always passes it, resolved from `retention` ?? DEFAULT_RETENTION), the status
   * flip, index move, retention TTL and bucket prune happen in ONE atomic script
   * (TERMINAL_SCRIPT) — no window where a crash could leave terminal state with no
   * TTL and a never-pruned index entry. When omitted, it falls back to a plain
   * status transition (index entry scored with the never-expire sentinel) so a
   * caller can still apply retention later via `expireInstance`.
   */
  private async terminalTransition(
    instanceId: string,
    status: TerminalStatus,
    patch: Partial<InstanceState>,
    ttlMs: number | undefined,
  ): Promise<void> {
    if (ttlMs === undefined) {
      await this.updateInstance(instanceId, patch)
      return
    }
    const fields = encodeInstanceFields(patch)
    const now = Date.now()
    await this.cmd("durableTerminal")(
      this.instanceKey(instanceId),
      this.stepsKey(instanceId),
      this.logsKey(instanceId),
      this.activeKey(),
      this.terminalKey(status),
      instanceId,
      String(ttlMs),
      String(now + ttlMs),
      String(now),
      ...fields,
    )
  }

  async nextResumeSeq(instanceId: string): Promise<number> {
    const key = this.instanceKey(instanceId)
    const results = await this.redis
      .multi()
      .hincrby(key, "resumeSeq", 1)
      .hset(key, "updatedAt", String(Date.now()))
      .exec()
    // ioredis returns an array of `[error, result]` tuples, one per command.
    const value = results?.[0]?.[1]
    return typeof value === "number" ? value : Number(value ?? 0)
  }

  async nextStepSeq(instanceId: string): Promise<number> {
    const key = this.instanceKey(instanceId)
    const results = await this.redis
      .multi()
      .hincrby(key, "stepSeq", 1)
      .hset(key, "updatedAt", String(Date.now()))
      .exec()
    const value = results?.[0]?.[1]
    return typeof value === "number" ? value : Number(value ?? 0)
  }

  // -- Steps ---------------------------------------------------------------

  async getStep(instanceId: string, stepKey: string): Promise<StepState | null> {
    const raw = await this.redis.hget(this.stepsKey(instanceId), stepKey)
    return raw ? (JSON.parse(raw) as StepState) : null
  }

  async getSteps(instanceId: string): Promise<StepState[]> {
    const hash = await this.redis.hgetall(this.stepsKey(instanceId))
    // HGETALL has no ordering guarantee, so sort by start time to give a stable,
    // chronological result that matches the in-memory store.
    return Object.values(hash)
      .map((raw) => JSON.parse(raw) as StepState)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  async saveStep(instanceId: string, stepKey: string, state: StepState): Promise<void> {
    await this.redis.hset(this.stepsKey(instanceId), stepKey, JSON.stringify(state))
  }

  async updateStep(instanceId: string, stepKey: string, patch: Partial<StepState>): Promise<void> {
    const current = await this.getStep(instanceId, stepKey)
    if (!current) return
    await this.saveStep(instanceId, stepKey, { ...current, ...patch })
  }

  // -- Logs ----------------------------------------------------------------

  async appendLog(
    instanceId: string,
    log: DurableLog,
    maxLogs: number = DEFAULT_MAX_LOGS,
  ): Promise<void> {
    // `maxLogs <= 0` disables log retention. Guard it explicitly: `ltrim(-0, -1)`
    // is `ltrim(0, -1)`, which keeps the whole list instead of emptying it.
    if (maxLogs <= 0) return
    const key = this.logsKey(instanceId)
    await this.redis.multi().rpush(key, JSON.stringify(log)).ltrim(key, -maxLogs, -1).exec()
  }

  async getLogs(instanceId: string): Promise<DurableLog[]> {
    const raw = await this.redis.lrange(this.logsKey(instanceId), 0, -1)
    return raw.map((entry) => JSON.parse(entry) as DurableLog)
  }

  // -- Locking -------------------------------------------------------------

  async acquireLock(instanceId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = (await this.cmd("durableLockAcquire")(
      this.lockKey(instanceId),
      token,
      String(ttlMs),
    )) as number
    return result === 1
  }

  async renewLock(instanceId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = (await this.cmd("durableLockRenew")(
      this.lockKey(instanceId),
      token,
      String(ttlMs),
    )) as number
    return result === 1
  }

  async releaseLock(instanceId: string, token: string): Promise<void> {
    await this.cmd("durableLockRelease")(this.lockKey(instanceId), token)
  }

  // -- Retention -----------------------------------------------------------

  async expireInstance(instanceId: string, ttlMs: number): Promise<void> {
    // Expire the data keys, re-score this instance's terminal index entry to its
    // real expiry epoch, AND prune the bucket of already-expired ids — so the
    // index stays bounded and exact without a reader having to prune it (see
    // EXPIRE_SCRIPT).
    const now = Date.now()
    await this.cmd("durableExpire")(
      this.instanceKey(instanceId),
      this.stepsKey(instanceId),
      this.logsKey(instanceId),
      this.terminalKey("completed"),
      this.terminalKey("failed"),
      this.terminalKey("cancelled"),
      this.terminalKey("compensation_failed"),
      String(ttlMs),
      String(now + ttlMs),
      instanceId,
      String(now),
    )
  }

  // -- Lifecycle -----------------------------------------------------------

  async close(): Promise<void> {
    await this.redis.quit()
  }

  // -- Internals -----------------------------------------------------------

  private instanceKey(id: string): string {
    return instanceKey(this.prefix, id)
  }

  private stepsKey(id: string): string {
    return stepsKey(this.prefix, id)
  }

  private logsKey(id: string): string {
    return logsKey(this.prefix, id)
  }

  private lockKey(id: string): string {
    return lockKey(this.prefix, id)
  }

  private activeKey(): string {
    return activeIndexKey(this.prefix)
  }

  private terminalKey(status: TerminalStatus): string {
    return terminalIndexKey(this.prefix, status)
  }

  /**
   * Resolve a custom (Lua) command defined via `defineCommand`, bound to the
   * client. The binding is essential: ioredis dispatches custom commands as
   * methods on the client, so calling a detached reference would lose `this`.
   */
  private cmd(name: string): (...args: Array<string | number>) => Promise<unknown> {
    const client = this.redis as unknown as Record<
      string,
      (...a: Array<string | number>) => Promise<unknown>
    >
    return client[name]!.bind(this.redis)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build (or duplicate) an ioredis client from a BullMQ connection option. */
function createClient(connection: ConnectionOptions): Redis {
  if (connection instanceof Redis) {
    // Use a dedicated connection so we never contend with BullMQ's clients.
    return connection.duplicate()
  }
  // ConnectionOptions also covers Cluster; those users should pass a custom
  // `stateStore` instead. For the common case, treat it as ioredis options.
  return new Redis(connection as unknown as RedisOptions)
}

/** Flatten the defined fields of an instance/patch into HSET argument pairs. */
function encodeInstanceFields(patch: Partial<InstanceState>): string[] {
  const out: string[] = []
  const str = (key: string, value: string | undefined) => {
    if (value !== undefined) out.push(key, value)
  }
  const num = (key: string, value: number | undefined) => {
    if (value !== undefined) out.push(key, String(value))
  }

  str("id", patch.id)
  str("queueName", patch.queueName)
  str("jobName", patch.jobName)
  str("originalJobId", patch.originalJobId)
  str("status", patch.status)
  str("failedStep", patch.failedStep)
  num("runCount", patch.runCount)
  num("resumeSeq", patch.resumeSeq)
  num("stepSeq", patch.stepSeq)
  num("createdAt", patch.createdAt)
  num("updatedAt", patch.updatedAt)
  num("completedAt", patch.completedAt)
  num("failedAt", patch.failedAt)
  // Only persist input/output when actually present. Coercing `undefined` to
  // `null` would make `getDurableState().output` differ from the in-memory store
  // (which preserves `undefined`) for a void job.
  if ("input" in patch && patch.input !== undefined) out.push("input", JSON.stringify(patch.input))
  if ("output" in patch && patch.output !== undefined) {
    out.push("output", JSON.stringify(patch.output))
  }
  if (patch.error !== undefined) out.push("error", JSON.stringify(patch.error))
  if (patch.failureError !== undefined) out.push("failureError", JSON.stringify(patch.failureError))
  if (patch.compensation !== undefined) out.push("compensation", JSON.stringify(patch.compensation))

  return out
}

/** Reconstruct an {@link InstanceState} from a Redis hash. */
function parseInstance(hash: Record<string, string>): InstanceState {
  return {
    id: hash.id ?? "",
    queueName: hash.queueName ?? "",
    jobName: hash.jobName ?? "",
    originalJobId: hash.originalJobId ?? "",
    status: (hash.status ?? "running") as InstanceStatus,
    input: hash.input !== undefined ? JSON.parse(hash.input) : undefined,
    output: hash.output !== undefined ? JSON.parse(hash.output) : undefined,
    error: hash.error !== undefined ? JSON.parse(hash.error) : undefined,
    failureError: hash.failureError !== undefined ? JSON.parse(hash.failureError) : undefined,
    failedStep: hash.failedStep,
    compensation: hash.compensation !== undefined ? JSON.parse(hash.compensation) : undefined,
    runCount: toInt(hash.runCount) ?? 0,
    resumeSeq: toInt(hash.resumeSeq) ?? 0,
    stepSeq: toInt(hash.stepSeq),
    createdAt: toInt(hash.createdAt) ?? 0,
    updatedAt: toInt(hash.updatedAt) ?? 0,
    completedAt: toInt(hash.completedAt),
    failedAt: toInt(hash.failedAt),
  }
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isNaN(n) ? undefined : n
}
