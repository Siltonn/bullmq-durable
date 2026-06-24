/**
 * Connection sharing for the NestJS integration.
 *
 * By default each {@link import("../queue").DurableQueue} and
 * {@link import("../worker").DurableWorker} would open its own
 * {@link RedisStateStore} (one Redis connection each). The module instead
 * creates a single shared store in `forRoot` and hands it to every queue and
 * worker, so an app with N queues uses one state connection instead of N.
 */

import { RedisStateStore } from "../store/redis-store"
import type { StateStore } from "../store/state-store"
import { DEFAULT_DURABLE_PREFIX } from "../utils/keys"
import type { DurableBullRootOptions } from "./types"

/** Build the module-wide store: the user's own if supplied, else a default Redis one. */
export function createSharedStore(root: DurableBullRootOptions): StateStore {
  return (
    root.stateStore ??
    new RedisStateStore({ connection: root.connection, prefix: root.durablePrefix })
  )
}

/**
 * Decide whether a queue/worker may reuse the module's shared store.
 *
 * A default (Redis) store is bound to a single key prefix, so a registration
 * that overrides `durablePrefix` to a *different* value must keep its own store.
 * A user-supplied store owns its key scheme entirely and is always reused.
 */
export function reuseSharedStore(
  shared: StateStore | undefined,
  root: Pick<DurableBullRootOptions, "stateStore" | "durablePrefix">,
  perQueuePrefix: string | undefined,
): StateStore | undefined {
  if (!shared) return undefined
  if (root.stateStore) return shared
  const sharedPrefix = root.durablePrefix ?? DEFAULT_DURABLE_PREFIX
  const effectivePrefix = perQueuePrefix ?? root.durablePrefix ?? DEFAULT_DURABLE_PREFIX
  return effectivePrefix === sharedPrefix ? shared : undefined
}
