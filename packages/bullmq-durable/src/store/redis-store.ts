/**
 * Redis-backed {@link StateStore} — the default, production implementation.
 *
 * Layout (see {@link import("../utils/keys")}):
 *  - `{prefix}:instance:{id}`  Hash   — instance fields
 *  - `{prefix}:steps:{id}`     Hash   — stepKey -> JSON(StepState)
 *  - `{prefix}:lock:{id}`      String — advisory instance lock
 *  - `{prefix}:idx:*`          Set/ZSets — status index (active + done buckets)
 *
 * State carries no TTL: a run's state lives exactly as long as its BullMQ job,
 * and the worker/queue layer reaps dead state through the reaper primitives
 * (`listActive` / `listOldestTerminal` / `removeInstances`). Done-bucket zsets
 * are scored by the terminal-transition timestamp (time-ordered).
 *
 * Durability depends entirely on how the underlying Redis is configured. See
 * the README's "Redis persistence" section before using this for
 * business-critical state.
 */

import type { ConnectionOptions } from "bullmq"
import { Redis, type RedisOptions } from "ioredis"
import type { DurableLogEntry, InstanceState, InstanceStatus, StepState } from "../types"
import {
  activeIndexKey,
  DEFAULT_DURABLE_PREFIX,
  instanceKey,
  legacyActiveIndexKey,
  legacyTerminalIndexKey,
  lockKey,
  logsKey,
  queuesRegistryKey,
  stepsKey,
  TERMINAL_STATUSES,
  terminalIndexKey,
  type TerminalStatus,
} from "../utils/keys"
import { cloneValue, serializeError } from "../utils/serialize"
import type { BeginStepInit, BeginStepResult, InitInstanceInput, StateStore } from "./state-store"

export interface RedisStateStoreOptions {
  /** A BullMQ-compatible connection: ioredis options or an existing client. */
  connection: ConnectionOptions
  /** Redis key prefix for durable state. Defaults to `"bullmq-durable"`. */
  prefix?: string
}

// Shared Lua fragments, composed into the scripts below.
//
// Index keys are built INSIDE the scripts from prefix + queueName (per-queue
// buckets). Dynamic key construction is not Redis-Cluster-safe — the same
// caveat as BullMQ's own scripts; single-node/replicated Redis is the target.

// Read a whole hash as one JSON blob (single-round-trip state returns).
const LUA_DUMP_HASH = `
local function dumpHash(key)
  local flat = redis.call('HGETALL', key)
  local hash = {}
  for i = 1, #flat, 2 do hash[flat[i]] = flat[i + 1] end
  return cjson.encode(hash)
end
`

// Drop an id from every done bucket (per-queue + pre-release legacy global).
// The status list must stay in lockstep with TERMINAL_STATUSES in utils/keys.
const LUA_CLEAR_DONE_BUCKETS = `
local function clearDoneBuckets(idx, prefix, id)
  for _, st in ipairs({'completed', 'failed', 'cancelled', 'compensation_failed'}) do
    redis.call('ZREM', idx .. ':done:' .. st, id)
    redis.call('ZREM', prefix .. ':idx:done:' .. st, id)
  end
end
`

// Begin an execution tick, in one round-trip. Creates the instance when absent
// (fields supplied by the caller; fresh instances join the active set and any
// stale done-bucket entry from a PRIOR run under a reused job id is cleared).
// When the instance exists and is non-terminal, bumps `runCount`, flips status
// to `running` (`compensating` preserved) and returns the full hash; terminal
// instances come back untouched. Returning the hash from the same script keeps
// the common resumed-tick path at a single round-trip.
//
// KEYS: [1] instance.
// ARGV: named in the header line; [CREATE_FIELDS_FROM..] HSET pairs for creation.
const BEGIN_TICK_SCRIPT = LUA_DUMP_HASH + LUA_CLEAR_DONE_BUCKETS + `
local id, now, prefix, queueName = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local CREATE_FIELDS_FROM = 5
local idx = prefix .. ':idx:' .. queueName
if redis.call('EXISTS', KEYS[1]) == 1 then
  local status = redis.call('HGET', KEYS[1], 'status')
  if status == 'completed' or status == 'failed'
      or status == 'compensation_failed' or status == 'cancelled' then
    return {'terminal', dumpHash(KEYS[1])}
  end
  redis.call('HINCRBY', KEYS[1], 'runCount', 1)
  if status ~= 'compensating' then
    redis.call('HSET', KEYS[1], 'status', 'running')
  end
  redis.call('HSET', KEYS[1], 'updatedAt', now)
  redis.call('SADD', idx .. ':active', id)
  return {'tick', dumpHash(KEYS[1])}
end
redis.call('HSET', KEYS[1], unpack(ARGV, CREATE_FIELDS_FROM))
redis.call('SADD', prefix .. ':queues', queueName)
clearDoneBuckets(idx, prefix, id)
redis.call('SADD', idx .. ':active', id)
return {'created', ''}
`

// Update-if-present. Returns 1 when the instance existed and was patched, 0 if
// it was absent — so a stray update (e.g. cancelling a job before its first
// tick) cannot conjure a half-populated "zombie" instance.
//
// KEYS: [1] instance hash.
// ARGV: named in the header line ('' status = patch doesn't change it);
//       [PATCH_FIELDS_FROM..] HSET field pairs.
// The index is maintained ONLY on a real status transition, atomically with the
// patch: terminal statuses leave the active set and enter their done-bucket;
// running/yielded/compensating stays active (SADD is idempotent, covering the
// backfill case where an in-flight instance wasn't yet indexed).
const UPDATE_SCRIPT = LUA_CLEAR_DONE_BUCKETS + `
local id, newStatus, score, prefix = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local PATCH_FIELDS_FROM = 5
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local old = redis.call('HGET', KEYS[1], 'status')
local q = redis.call('HGET', KEYS[1], 'queueName')
redis.call('HSET', KEYS[1], unpack(ARGV, PATCH_FIELDS_FROM))
if newStatus ~= '' and newStatus ~= old and q then
  local idx = prefix .. ':idx:' .. q
  if newStatus == 'completed' or newStatus == 'failed' or newStatus == 'cancelled'
      or newStatus == 'compensation_failed' then
    redis.call('SREM', idx .. ':active', id)
    redis.call('SREM', prefix .. ':idx:active', id)
    redis.call('ZADD', idx .. ':done:' .. newStatus, score, id)
  else
    clearDoneBuckets(idx, prefix, id)
    redis.call('SADD', idx .. ':active', id)
  end
end
return 1
`

// Atomic, token-fenced terminal transition: flip the status and move the id
// from the active set into its done-bucket (scored by transition time). When a
// lock token is supplied, the transition only applies while the instance lock
// is free or held by that token — a zombie worker whose lock was taken over
// gets -1 and cannot flip a state someone else now owns (BullMQ's job lock
// fences job-state transitions; this fences OUR state the same way).
//
// KEYS: [1] instance, [2] lock.
// ARGV: named in the header line ('' lock token = unfenced);
//       [PATCH_FIELDS_FROM..] HSET field pairs.
const TERMINAL_SCRIPT = `
local id, score, lockToken, prefix, status = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]
local PATCH_FIELDS_FROM = 6
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if lockToken ~= '' then
  local cur = redis.call('GET', KEYS[2])
  if cur ~= false and cur ~= lockToken then
    return -1
  end
end
local q = redis.call('HGET', KEYS[1], 'queueName')
redis.call('HSET', KEYS[1], unpack(ARGV, PATCH_FIELDS_FROM))
if q then
  local idx = prefix .. ':idx:' .. q
  redis.call('SREM', idx .. ':active', id)
  redis.call('SREM', prefix .. ':idx:active', id)
  redis.call('ZADD', idx .. ':done:' .. status, score, id)
end
return 1
`

// One-round-trip step entry: instance check, existing-state read, and — for a
// new step — seq allocation plus the initial `running` record, atomically.
//
// KEYS: [1] instance, [2] steps.
// ARGV: named in the header line ('' nextRunAt = none).
const BEGIN_STEP_SCRIPT = `
local storageKey, key, stepType, phase, now, nextRunAt =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6]
local status = redis.call('HGET', KEYS[1], 'status')
if status == false then
  return {'missing', ''}
end
if status == 'cancelled' then
  return {'cancelled', ''}
end
local raw = redis.call('HGET', KEYS[2], storageKey)
if raw then
  return {'existing', raw}
end
local seq = redis.call('HINCRBY', KEYS[1], 'stepSeq', 1)
local state = {
  key = key,
  type = stepType,
  phase = phase,
  seq = seq,
  status = 'running',
  attempts = 1,
  startedAt = tonumber(now),
}
if nextRunAt ~= '' then
  state.nextRunAt = tonumber(nextRunAt)
end
redis.call('HSET', KEYS[2], storageKey, cjson.encode(state))
redis.call('HSET', KEYS[1], 'updatedAt', now)
return {'created', tostring(seq)}
`

// Acquire or re-enter a lock: succeeds if the lock is free or already ours.
const LOCK_ACQUIRE_SCRIPT = `
local token, ttlMs = ARGV[1], ARGV[2]
local cur = redis.call('GET', KEYS[1])
if cur == false or cur == token then
  redis.call('SET', KEYS[1], token, 'PX', ttlMs)
  return 1
end
return 0
`

const LOCK_RENEW_SCRIPT = `
local token, ttlMs = ARGV[1], ARGV[2]
if redis.call('GET', KEYS[1]) == token then
  return redis.call('PEXPIRE', KEYS[1], ttlMs)
end
return 0
`

const LOCK_RELEASE_SCRIPT = `
local token = ARGV[1]
if redis.call('GET', KEYS[1]) == token then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export class RedisStateStore implements StateStore {
  private client?: Redis
  private readonly prefix: string

  constructor(private readonly options: RedisStateStoreOptions) {
    this.prefix = options.prefix ?? DEFAULT_DURABLE_PREFIX
  }

  /**
   * Lazily open the connection on first use — merely constructing a store
   * (e.g. a dashboard probing whether durable is deployed at all) must not
   * cost a Redis connection.
   */
  private get redis(): Redis {
    if (!this.client) {
      this.client = createClient(this.options.connection)

      // Register the Lua helpers as cached, named commands. The key counts must
      // match each script's KEYS arity (see the script comments above).
      this.client.defineCommand("durableBeginTick", { numberOfKeys: 1, lua: BEGIN_TICK_SCRIPT })
      this.client.defineCommand("durableUpdate", { numberOfKeys: 1, lua: UPDATE_SCRIPT })
      this.client.defineCommand("durableTerminal", { numberOfKeys: 2, lua: TERMINAL_SCRIPT })
      this.client.defineCommand("durableBeginStep", { numberOfKeys: 2, lua: BEGIN_STEP_SCRIPT })
      this.client.defineCommand("durableLockAcquire", { numberOfKeys: 1, lua: LOCK_ACQUIRE_SCRIPT })
      this.client.defineCommand("durableLockRenew", { numberOfKeys: 1, lua: LOCK_RENEW_SCRIPT })
      this.client.defineCommand("durableLockRelease", { numberOfKeys: 1, lua: LOCK_RELEASE_SCRIPT })
    }
    return this.client
  }

  // -- Instance lifecycle --------------------------------------------------

  async initInstance(input: InitInstanceInput): Promise<InstanceState> {
    const now = Date.now()
    const fresh: InstanceState = {
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

    const [outcome, dumped] = await this.runBeginTickScript({
      instanceId: input.instanceId,
      now,
      queueName: input.queueName,
      createFields: encodeInstanceFields(fresh),
    })

    if (outcome === "created") return fresh
    return parseInstance(
      JSON.parse(dumped) as Record<string, string>,
      input.instanceId,
    )
  }

  async getInstance(instanceId: string): Promise<InstanceState | null> {
    const hash = await this.redis.hgetall(this.instanceKey(instanceId))
    if (!hash || Object.keys(hash).length === 0) return null
    return parseInstance(hash, instanceId)
  }

  async getInstances(instanceIds: string[]): Promise<Array<InstanceState | null>> {
    if (instanceIds.length === 0) return []
    const pipeline = this.redis.pipeline()
    for (const id of instanceIds) pipeline.hgetall(this.instanceKey(id))
    const results = await pipeline.exec()
    return instanceIds.map((id, index) => {
      const [err, hash] = results?.[index] ?? [null, null]
      if (err || !hash || Object.keys(hash as Record<string, string>).length === 0) return null
      try {
        return parseInstance(hash as Record<string, string>, id)
      } catch {
        return null // one corrupted record must not brick a bulk read
      }
    })
  }

  async updateInstance(
    instanceId: string,
    patch: Partial<InstanceState>,
  ): Promise<InstanceState | null> {
    const fields = encodeInstanceFields({ ...patch, updatedAt: patch.updatedAt ?? Date.now() })
    if (fields.length === 0) return this.getInstance(instanceId)

    // A patch that doesn't set `status` passes "" so the Lua skips all index
    // work — the common non-transition update (runCount / output) costs
    // nothing extra.
    const updated = await this.runUpdateScript({
      instanceId,
      newStatus: patch.status ?? "",
      score: Date.now(),
      patchFields: fields,
    })
    if (updated === 0) return null
    return this.getInstance(instanceId)
  }

  async completeInstance(
    instanceId: string,
    output: unknown,
    lockToken?: string,
  ): Promise<boolean> {
    const now = Date.now()
    return this.terminalTransition(
      instanceId,
      "completed",
      { status: "completed", output, completedAt: now, updatedAt: now },
      lockToken,
    )
  }

  async failInstance(instanceId: string, error: unknown, lockToken?: string): Promise<boolean> {
    const now = Date.now()
    return this.terminalTransition(
      instanceId,
      "failed",
      { status: "failed", error: serializeError(error), failedAt: now, updatedAt: now },
      lockToken,
    )
  }

  async compensationFailedInstance(
    instanceId: string,
    error: unknown,
    lockToken?: string,
  ): Promise<boolean> {
    const now = Date.now()
    return this.terminalTransition(
      instanceId,
      "compensation_failed",
      {
        status: "compensation_failed",
        error: serializeError(error),
        failedAt: now,
        updatedAt: now,
      },
      lockToken,
    )
  }

  async cancelInstance(instanceId: string, lockToken?: string): Promise<boolean> {
    return this.terminalTransition(
      instanceId,
      "cancelled",
      { status: "cancelled", updatedAt: Date.now() },
      lockToken,
    )
  }

  /**
   * Move an instance to a terminal status: status flip + index move in one
   * atomic, optionally token-fenced script. No TTL is applied — terminal state
   * is reclaimed by the reaper once its BullMQ job disappears.
   */
  private async terminalTransition(
    instanceId: string,
    status: TerminalStatus,
    patch: Partial<InstanceState>,
    lockToken: string | undefined,
  ): Promise<boolean> {
    const result = await this.runTerminalScript({
      instanceId,
      score: Date.now(),
      lockToken,
      status,
      patchFields: encodeInstanceFields(patch),
    })
    return result === 1
  }

  // -- Steps ---------------------------------------------------------------

  async beginStep(
    instanceId: string,
    stepKey: string,
    init: BeginStepInit,
  ): Promise<BeginStepResult> {
    const [outcome, payload] = await this.runBeginStepScript({
      instanceId,
      storageKey: stepKey,
      init,
    })

    switch (outcome) {
      case "missing":
        return { kind: "missing" }
      case "cancelled":
        return { kind: "cancelled" }
      case "existing":
        return { kind: "existing", step: parseStep(payload, instanceId, stepKey) }
      default:
        return { kind: "created", seq: Number(payload) }
    }
  }

  async getStep(instanceId: string, stepKey: string): Promise<StepState | null> {
    const raw = await this.redis.hget(this.stepsKey(instanceId), stepKey)
    return raw ? parseStep(raw, instanceId, stepKey) : null
  }

  async getSteps(instanceId: string): Promise<StepState[]> {
    const hash = await this.redis.hgetall(this.stepsKey(instanceId))
    // HGETALL has no ordering guarantee, so sort by seq (falling back to start
    // time) to give a stable result that matches the in-memory store.
    return Object.entries(hash)
      .map(([field, raw]) => parseStep(raw, instanceId, field))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  async saveStep(instanceId: string, stepKey: string, state: StepState): Promise<void> {
    await this.redis.hset(this.stepsKey(instanceId), stepKey, JSON.stringify(state))
  }

  async updateStep(instanceId: string, stepKey: string, patch: Partial<StepState>): Promise<void> {
    const current = await this.getStep(instanceId, stepKey)
    if (!current) return
    await this.saveStep(instanceId, stepKey, { ...current, ...patch })
  }

  async removeSteps(instanceId: string, stepKeys: string[]): Promise<void> {
    if (stepKeys.length === 0) return
    await this.redis.hdel(this.stepsKey(instanceId), ...stepKeys)
  }

  async clearInstanceFields(instanceId: string, fields: string[]): Promise<void> {
    const pipeline = this.redis.pipeline()
    if (fields.length > 0) pipeline.hdel(this.instanceKey(instanceId), ...fields)
    // Legacy 0.1.x data may still carry retention TTLs — a reactivated
    // instance must not expire mid-run. PERSIST is a no-op without a TTL.
    pipeline.persist(this.instanceKey(instanceId))
    pipeline.persist(this.stepsKey(instanceId))
    pipeline.persist(logsKey(this.prefix, instanceId))
    assertPipelineOk(await pipeline.exec(), "clearInstanceFields")
  }

  // -- Locking -------------------------------------------------------------

  async acquireLock(instanceId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = (await this.cmd("durableLockAcquire")(
      this.lockKey(instanceId),
      // ARGV: token, ttlMs — named in the script header.
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

  // -- Lua command wrappers ---------------------------------------------------
  // Each wrapper is the single owner of its script's positional wire order:
  // the tuple built here lines up 1:1 with the named-locals header line at the
  // top of the corresponding script. Call sites only ever pass named fields.

  private runBeginTickScript(p: {
    instanceId: string
    now: number
    queueName: string
    createFields: string[]
  }): Promise<[outcome: string, dumpedHash: string]> {
    return this.cmd("durableBeginTick")(
      this.instanceKey(p.instanceId),
      // local id, now, prefix, queueName = ARGV[1..4]; [5..] create pairs
      p.instanceId,
      String(p.now),
      this.prefix,
      p.queueName,
      ...p.createFields,
    ) as Promise<[string, string]>
  }

  private runUpdateScript(p: {
    instanceId: string
    newStatus: InstanceStatus | ""
    score: number
    patchFields: string[]
  }): Promise<number> {
    return this.cmd("durableUpdate")(
      this.instanceKey(p.instanceId),
      // local id, newStatus, score, prefix = ARGV[1..4]; [5..] patch pairs
      p.instanceId,
      p.newStatus,
      String(p.score),
      this.prefix,
      ...p.patchFields,
    ) as Promise<number>
  }

  private runTerminalScript(p: {
    instanceId: string
    score: number
    lockToken: string | undefined
    status: TerminalStatus
    patchFields: string[]
  }): Promise<number> {
    return this.cmd("durableTerminal")(
      this.instanceKey(p.instanceId),
      this.lockKey(p.instanceId),
      // local id, score, lockToken, prefix, status = ARGV[1..5]; [6..] patch pairs
      p.instanceId,
      String(p.score),
      p.lockToken ?? "",
      this.prefix,
      p.status,
      ...p.patchFields,
    ) as Promise<number>
  }

  private runBeginStepScript(p: {
    instanceId: string
    storageKey: string
    init: BeginStepInit
  }): Promise<[outcome: string, payload: string]> {
    return this.cmd("durableBeginStep")(
      this.instanceKey(p.instanceId),
      this.stepsKey(p.instanceId),
      // local storageKey, key, stepType, phase, now, nextRunAt = ARGV[1..6]
      p.storageKey,
      p.init.key,
      p.init.type,
      p.init.phase,
      String(p.init.now),
      p.init.nextRunAt !== undefined ? String(p.init.nextRunAt) : "",
    ) as Promise<[string, string]>
  }

  // -- Reaper primitives -----------------------------------------------------

  async queues(): Promise<string[]> {
    return this.redis.smembers(queuesRegistryKey(this.prefix))
  }

  async registerQueue(queueName: string): Promise<void> {
    await this.redis.sadd(queuesRegistryKey(this.prefix), queueName)
  }

  async listActive(queueName: string): Promise<string[]> {
    const [current, legacy] = await Promise.all([
      this.redis.smembers(activeIndexKey(this.prefix, queueName)),
      // Pre-release global set: read-only transition window (0.3.0 removes it).
      this.redis.smembers(legacyActiveIndexKey(this.prefix)).catch(() => [] as string[]),
    ])
    const mine = legacy.filter((id) => id.startsWith(`${queueName}:`))
    return mine.length === 0 ? current : [...new Set([...current, ...mine])]
  }

  async listOldestTerminal(
    queueName: string,
    status: TerminalStatus,
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0) return []
    const current = await this.redis.zrange(
      terminalIndexKey(this.prefix, queueName, status),
      0,
      limit - 1,
    )
    if (current.length >= limit) return current
    // Transition top-up from the legacy global bucket (bounded over-fetch).
    const legacy = (
      await this.redis
        .zrange(legacyTerminalIndexKey(this.prefix, status), 0, limit * 8 - 1)
        .catch(() => [] as string[])
    ).filter((id) => id.startsWith(`${queueName}:`))
    if (legacy.length === 0) return current
    return [...new Set([...legacy, ...current])].slice(0, limit)
  }

  async listNewestTerminal(
    queueName: string,
    status: TerminalStatus,
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0) return []
    const current = await this.redis.zrevrange(
      terminalIndexKey(this.prefix, queueName, status),
      0,
      limit - 1,
    )
    if (current.length >= limit) return current
    const legacy = (
      await this.redis
        .zrevrange(legacyTerminalIndexKey(this.prefix, status), 0, limit * 8 - 1)
        .catch(() => [] as string[])
    ).filter((id) => id.startsWith(`${queueName}:`))
    if (legacy.length === 0) return current
    return [...new Set([...current, ...legacy])].slice(0, limit)
  }

  async listTerminalPage(
    queueName: string,
    status: TerminalStatus,
    query: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<string[]> {
    const { offset, limit, order } = query
    if (limit <= 0) return []
    const key = terminalIndexKey(this.prefix, queueName, status)
    const primary =
      order === "asc"
        ? await this.redis.zrange(key, offset, offset + limit - 1)
        : await this.redis.zrevrange(key, offset, offset + limit - 1)
    if (primary.length >= limit) return primary

    // Transition window (0.3.0 removes it): 0.1.x leftovers live in a global
    // bucket. Treat this queue's filtered leftovers as appended AFTER the
    // per-queue bucket — same convention as the window reads.
    const legacyAll = (
      await (order === "asc"
        ? this.redis.zrange(legacyTerminalIndexKey(this.prefix, status), 0, -1)
        : this.redis.zrevrange(legacyTerminalIndexKey(this.prefix, status), 0, -1)
      ).catch(() => [] as string[])
    ).filter((id) => id.startsWith(`${queueName}:`))
    if (legacyAll.length === 0) return primary

    const primaryTotal = await this.redis.zcard(key)
    const seen = new Set(primary)
    const legacyOffset = Math.max(0, offset - primaryTotal)
    const topUp = legacyAll
      .filter((id) => !seen.has(id))
      .slice(legacyOffset, legacyOffset + (limit - primary.length))
    return [...primary, ...topUp]
  }

  async countTerminal(queueName: string, status: TerminalStatus): Promise<number> {
    const [current, legacyMembers] = await Promise.all([
      this.redis.zcard(terminalIndexKey(this.prefix, queueName, status)),
      // Transition window: count this queue's leftovers in the legacy bucket.
      this.redis
        .zrange(legacyTerminalIndexKey(this.prefix, status), 0, -1)
        .then((ids) => ids.filter((id) => id.startsWith(`${queueName}:`)).length)
        .catch(() => 0),
    ])
    return current + legacyMembers
  }

  async legacyLogs(instanceId: string): Promise<DurableLogEntry[]> {
    const raw = await this.redis
      .lrange(logsKey(this.prefix, instanceId), 0, -1)
      .catch(() => [] as string[])
    const out: DurableLogEntry[] = []
    for (const line of raw) {
      try {
        const parsed = JSON.parse(line) as { message?: string; timestamp?: number; meta?: Record<string, unknown> }
        if (typeof parsed.message === "string") {
          out.push({
            message: parsed.message,
            timestamp: parsed.timestamp ?? 0,
            kind: "log",
            ...(parsed.meta ? { meta: parsed.meta } : {}),
          })
        }
      } catch {
        out.push({ message: line, timestamp: 0, kind: "raw" })
      }
    }
    return out
  }

  async removeInstances(queueName: string, instanceIds: string[]): Promise<void> {
    if (instanceIds.length === 0) return
    // Chunked pipelines: obliterate() can hand us thousands of ids at once.
    const CHUNK = 200
    for (let i = 0; i < instanceIds.length; i += CHUNK) {
      const chunk = instanceIds.slice(i, i + CHUNK)
      const pipeline = this.redis.pipeline()
      for (const id of chunk) {
        // The legacy 0.1.x logs list rides along so upgraded deployments never
        // leak it (0.2.x logs live in the BullMQ job log). Remove in 0.3.0.
        pipeline.del(this.instanceKey(id), this.stepsKey(id), logsKey(this.prefix, id))
        pipeline.srem(activeIndexKey(this.prefix, queueName), id)
        pipeline.srem(legacyActiveIndexKey(this.prefix), id)
        for (const status of TERMINAL_STATUSES) {
          pipeline.zrem(terminalIndexKey(this.prefix, queueName, status), id)
          pipeline.zrem(legacyTerminalIndexKey(this.prefix, status), id)
        }
      }
      const results = await pipeline.exec()
      assertPipelineOk(results, "removeInstances")
    }
  }

  async wipeQueue(queueName: string): Promise<void> {
    // Chunked drain: a bucket can hold as many entries as the queue retains
    // jobs — never materialise it in one array.
    const CHUNK = 500
    for (;;) {
      const ids = new Set<string>(
        await this.redis.smembers(activeIndexKey(this.prefix, queueName)),
      )
      for (const status of TERMINAL_STATUSES) {
        for (const id of await this.redis.zrange(
          terminalIndexKey(this.prefix, queueName, status),
          0,
          CHUNK - 1,
        )) {
          ids.add(id)
        }
      }
      // Legacy global entries for this queue ride along.
      for (const id of (
        await this.redis.smembers(legacyActiveIndexKey(this.prefix)).catch(() => [] as string[])
      ).filter((id) => id.startsWith(`${queueName}:`))) {
        ids.add(id)
      }
      if (ids.size === 0) break
      await this.removeInstances(queueName, [...ids])
      if (ids.size < CHUNK) break
    }
    await this.redis.del(
      activeIndexKey(this.prefix, queueName),
      ...TERMINAL_STATUSES.map((status) => terminalIndexKey(this.prefix, queueName, status)),
    )
    await this.redis.srem(queuesRegistryKey(this.prefix), queueName)
  }

  async wipeAll(): Promise<void> {
    for (const queueName of await this.queues()) {
      await this.wipeQueue(queueName)
    }
    // Legacy global keys: drain whatever remains (pre-per-queue data), chunked.
    for (const status of TERMINAL_STATUSES) {
      const key = legacyTerminalIndexKey(this.prefix, status)
      for (;;) {
        const ids = await this.redis.zrange(key, 0, 499)
        if (ids.length === 0) break
        const pipeline = this.redis.pipeline()
        for (const id of ids) {
          pipeline.del(this.instanceKey(id), this.stepsKey(id), logsKey(this.prefix, id))
          pipeline.zrem(key, id)
        }
        assertPipelineOk(await pipeline.exec(), "wipeAll")
      }
    }
    await this.redis.del(
      legacyActiveIndexKey(this.prefix),
      ...TERMINAL_STATUSES.map((status) => legacyTerminalIndexKey(this.prefix, status)),
      queuesRegistryKey(this.prefix),
    )
  }

  async heldLocks(instanceIds: string[]): Promise<Set<string>> {
    const held = new Set<string>()
    if (instanceIds.length === 0) return held
    const pipeline = this.redis.pipeline()
    for (const id of instanceIds) pipeline.exists(this.lockKey(id))
    const results = await pipeline.exec()
    results?.forEach(([, exists], index) => {
      if (exists === 1) held.add(instanceIds[index]!)
    })
    return held
  }

  // -- Lifecycle -----------------------------------------------------------

  async close(): Promise<void> {
    // Only quit a connection that was actually opened — closing a never-used
    // store must not dial Redis just to hang up.
    if (this.client) await this.client.quit()
  }

  // -- Internals -----------------------------------------------------------

  private instanceKey(id: string): string {
    return instanceKey(this.prefix, id)
  }

  private stepsKey(id: string): string {
    return stepsKey(this.prefix, id)
  }

  private lockKey(id: string): string {
    return lockKey(this.prefix, id)
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

/**
 * Fail loudly (with context) when any command in a pipeline errored. ioredis
 * resolves pipelines even when individual commands fail — swallowing that
 * turns real Redis problems into silent state divergence.
 */
function assertPipelineOk(
  results: Array<[error: Error | null, result: unknown]> | null,
  op: string,
): void {
  if (results === null) {
    throw new Error(`bullmq-durable: redis pipeline for ${op} returned no results`)
  }
  for (const [error] of results) {
    if (error) {
      throw new Error(`bullmq-durable: redis pipeline for ${op} failed: ${error.message}`)
    }
  }
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
  num("stepSeq", patch.stepSeq)
  num("createdAt", patch.createdAt)
  num("updatedAt", patch.updatedAt)
  num("completedAt", patch.completedAt)
  num("failedAt", patch.failedAt)
  // `resumeSeq` is legacy (0.1.x) — parsed for upgrade compatibility, never
  // written by 0.2.x.
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

/**
 * Parse one JSON field, failing with enough context to locate the corrupted
 * key instead of a bare SyntaxError that bricks every tick anonymously.
 */
function parseJsonField<T>(raw: string, instanceId: string, field: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(
      `bullmq-durable: corrupted JSON in instance "${instanceId}" field "${field}": ` +
        `${(error as Error).message}`,
    )
  }
}

/** Reconstruct an {@link InstanceState} from a Redis hash. */
function parseInstance(hash: Record<string, string>, instanceId: string): InstanceState {
  const json = <T>(field: string): T | undefined =>
    hash[field] !== undefined ? parseJsonField<T>(hash[field], instanceId, field) : undefined

  return {
    id: hash.id ?? "",
    queueName: hash.queueName ?? "",
    jobName: hash.jobName ?? "",
    originalJobId: hash.originalJobId ?? "",
    status: (hash.status ?? "running") as InstanceStatus,
    input: json("input"),
    output: json("output"),
    error: json("error"),
    failureError: json("failureError"),
    failedStep: hash.failedStep,
    compensation: json("compensation"),
    runCount: toInt(hash.runCount) ?? 0,
    // Legacy 0.1.x field: read-only, used by cancel() to find in-flight resume
    // jobs across a rolling upgrade.
    resumeSeq: toInt(hash.resumeSeq),
    stepSeq: toInt(hash.stepSeq),
    createdAt: toInt(hash.createdAt) ?? 0,
    updatedAt: toInt(hash.updatedAt) ?? 0,
    completedAt: toInt(hash.completedAt),
    failedAt: toInt(hash.failedAt),
  }
}

/** Parse one step's JSON with locating context. */
function parseStep(raw: string, instanceId: string, stepKey: string): StepState {
  try {
    return JSON.parse(raw) as StepState
  } catch (error) {
    throw new Error(
      `bullmq-durable: corrupted JSON for step "${stepKey}" of instance "${instanceId}": ` +
        `${(error as Error).message}`,
    )
  }
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isNaN(n) ? undefined : n
}
