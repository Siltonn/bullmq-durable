/**
 * The board context: the long-lived object every route closes over.
 *
 * It owns the shared Redis client, a lazy cache of BullMQ `Queue` instances, and
 * the three inspectors. Building it opens exactly one extra Redis connection
 * (for scans) plus one `Queue` per queue actually touched.
 */

import { Queue } from "bullmq"
import type { Redis } from "ioredis"
import {
  AlertsInspector,
  startAlertScheduler,
  type AlertScheduler,
} from "./inspectors/alerts-inspector"
import { type BullMQInspector, createBullMQInspector } from "./inspectors/bullmq"
import { DurableInspector } from "./inspectors/durable-inspector"
import { HealthInspector } from "./inspectors/health-inspector"
import type { NormalizedCockpitOptions } from "./options"
import { createRedisClient } from "./infra/redis"

export interface BoardContext {
  options: NormalizedCockpitOptions
  redis: Redis
  getQueue: (name: string) => Queue
  bullmq: BullMQInspector
  durable?: DurableInspector
  health: HealthInspector
  alerts: AlertsInspector
  /** Tear down every connection this context opened. */
  close: () => Promise<void>
}

export function createBoardContext(options: NormalizedCockpitOptions): BoardContext {
  const redis = createRedisClient(options.connection)
  const queues = new Map<string, Queue>()

  const getQueue = (name: string): Queue => {
    let queue = queues.get(name)
    if (!queue) {
      queue = new Queue(name, { connection: options.connection, prefix: options.bullPrefix })
      queues.set(name, queue)
    }
    return queue
  }

  const durable = options.durable.enabled
    ? new DurableInspector({
        redis,
        prefix: options.durable.prefix,
        stuckThresholdMs: options.durable.stuckThresholdMs,
        getQueue,
      })
    : undefined

  const bullmq = createBullMQInspector({
    redis,
    bullPrefix: options.bullPrefix,
    queues: options.queues,
    getQueue,
    durable,
  })

  const health = new HealthInspector({
    redis,
    bullmq,
    durable,
    durableEnabled: options.durable.enabled,
    stuckThresholdMs: options.durable.stuckThresholdMs,
    getQueue,
  })

  const alerts = new AlertsInspector({
    redis,
    prefix: options.cockpitPrefix,
    bullmq,
    health,
    durableEnabled: options.durable.enabled,
  })

  // The background notifier (ok→firing dispatch). The dashboard evaluates live
  // regardless; this only powers channel notifications.
  let scheduler: AlertScheduler | undefined
  if (options.alerts.enabled) {
    scheduler = startAlertScheduler(alerts, options.alerts.intervalMs)
  }

  const close = async (): Promise<void> => {
    scheduler?.stop()
    await Promise.allSettled([...[...queues.values()].map((q) => q.close()), redis.quit()])
  }

  return { options, redis, getQueue, bullmq, durable, health, alerts, close }
}
