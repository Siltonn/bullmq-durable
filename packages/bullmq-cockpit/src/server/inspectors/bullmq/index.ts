/**
 * BullMQInspector — the read/act layer over plain BullMQ.
 *
 * Routes never touch BullMQ or Redis directly; they go through this object so
 * all queue/job semantics live in one place. It is composed (by spread) from
 * focused per-domain inspectors — queues, jobs, schedulers, metrics, flows,
 * redis — each a small file taking the shared {@link BullMQInspectorDeps}.
 */

import { createFlowInspector } from "./flow-inspector"
import { createJobInspector } from "./job-inspector"
import { createMetricsInspector } from "./metrics-inspector"
import { createQueueInspector } from "./queue-inspector"
import { createRedisInspector } from "./redis-inspector"
import { createSchedulerInspector } from "./scheduler-inspector"
import type { BullMQInspectorDeps } from "./shared"

export type { BullMQInspectorDeps } from "./shared"
export type { CleanOptions } from "./queue-inspector"
export type { JobListQuery } from "./job-inspector"

/** The composed read/act facade over plain BullMQ. */
export function createBullMQInspector(deps: BullMQInspectorDeps) {
  return {
    ...createQueueInspector(deps),
    ...createJobInspector(deps),
    ...createSchedulerInspector(deps),
    ...createMetricsInspector(deps),
    ...createFlowInspector(deps),
    ...createRedisInspector(deps),
  }
}

export type BullMQInspector = ReturnType<typeof createBullMQInspector>
