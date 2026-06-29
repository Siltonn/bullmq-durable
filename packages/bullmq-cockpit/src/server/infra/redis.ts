/**
 * A single place to turn a BullMQ {@link ConnectionOptions} into a raw ioredis
 * client. The cockpit uses this client for things BullMQ's `Queue` does not
 * expose: SCANning durable state and discovering queue names from Redis keys.
 */

import type { ConnectionOptions } from "bullmq"
import { Redis, type RedisOptions } from "ioredis"

/**
 * Build (or duplicate) an ioredis client from a connection option.
 *
 * If the caller passed a live `Redis` instance we duplicate it so the cockpit's
 * scanning never contends with the host application's own client. Cluster users
 * should pass options the cockpit can construct from; advanced setups can supply
 * their own client as the connection.
 */
export function createRedisClient(connection: ConnectionOptions): Redis {
  if (connection instanceof Redis) {
    return connection.duplicate()
  }
  return new Redis(connection as RedisOptions)
}

/**
 * SCAN a key pattern into a flat array. Wraps the cursor loop so callers get a
 * simple `Promise<string[]>`; `count` is a hint, not a hard page size.
 */
export async function scanKeys(redis: Redis, pattern: string, count = 500): Promise<string[]> {
  const found: string[] = []
  let cursor = "0"
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", count)
    cursor = next
    if (keys.length > 0) found.push(...keys)
  } while (cursor !== "0")
  return found
}
