/** Redis server snapshot (the `INFO` command). */

import type { RedisInfo } from "../../../shared/dto"
import type { BullMQInspectorDeps } from "./shared"

export function createRedisInspector(deps: BullMQInspectorDeps) {
  const { redis } = deps

  return {
    async redisInfo(): Promise<RedisInfo> {
      const raw = await redis.info().catch(() => "")
      const map = parseRedisInfo(raw)
      const dbKeys = await redis.dbsize().catch(() => undefined)
      const num = (key: string): number | undefined => {
        const v = map[key]
        if (v === undefined) return undefined
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
      }
      return {
        version: map.redis_version,
        mode: map.redis_mode,
        uptimeSeconds: num("uptime_in_seconds"),
        connectedClients: num("connected_clients"),
        usedMemory: num("used_memory"),
        usedMemoryHuman: map.used_memory_human,
        maxMemory: num("maxmemory"),
        maxMemoryPolicy: map.maxmemory_policy,
        opsPerSec: num("instantaneous_ops_per_sec"),
        keyspaceHits: num("keyspace_hits"),
        keyspaceMisses: num("keyspace_misses"),
        evictedKeys: num("evicted_keys"),
        dbKeys,
      }
    },
  }
}

function parseRedisInfo(raw: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf(":")
    if (idx < 0) continue
    map[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return map
}
