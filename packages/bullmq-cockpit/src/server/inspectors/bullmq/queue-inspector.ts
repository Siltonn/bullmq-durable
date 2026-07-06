/** Queue-level reads + lifecycle actions (pause / resume / drain / clean). */

import type { Queue } from "bullmq"
import type { QueueDetail, QueueSummary } from "../../../shared/dto"
import { type BullMQInspectorDeps, jobCounts, resolveQueueNames, workerCount } from "./shared"

/** The job sets BullMQ's `Queue.clean` accepts — sourced from its own signature. */
export type CleanStatus = NonNullable<Parameters<Queue["clean"]>[2]>

export interface CleanOptions {
  /** Only clean jobs older than this many ms. Defaults to 0 (all). */
  graceMs?: number
  /** Max jobs to remove. Defaults to 1000. */
  limit?: number
  /** Which set to clean. Defaults to `completed`. */
  status?: CleanStatus
}

export function createQueueInspector(deps: BullMQInspectorDeps) {
  const { getQueue, bullPrefix, durable } = deps

  const queueNames = (): Promise<string[]> => resolveQueueNames(deps)

  const queueSummary = async (name: string): Promise<QueueSummary> => {
    const queue = getQueue(name)
    const [counts, isPaused, workers] = await Promise.all([
      jobCounts(queue),
      queue.isPaused().catch(() => false),
      workerCount(queue),
    ])
    return { name, counts, isPaused, workers }
  }

  return {
    /** Resolve the set of queue names this cockpit exposes. */
    queueNames,

    async listQueues(): Promise<QueueSummary[]> {
      const names = await queueNames()
      return Promise.all(names.map((name) => queueSummary(name)))
    },

    async getQueueDetail(name: string): Promise<QueueDetail | null> {
      const names = await queueNames()
      if (!names.includes(name)) return null
      const summary = await queueSummary(name)
      return { ...summary, prefix: bullPrefix, durable: Boolean(durable) }
    },

    async pauseQueue(name: string): Promise<void> {
      await getQueue(name).pause()
    },
    async resumeQueue(name: string): Promise<void> {
      await getQueue(name).resume()
    },
    // Drain/clean route through the durable layer when it is enabled: a bare
    // bulk removal strands the removed jobs' run state (phantom active runs
    // until a worker restart); the durable variants delete/reap it in the
    // same action.
    async drainQueue(name: string): Promise<void> {
      if (durable) await durable.drainQueue(name)
      else await getQueue(name).drain()
    },
    async cleanQueue(name: string, options: CleanOptions): Promise<void> {
      const graceMs = options.graceMs ?? 0
      const limit = options.limit ?? 1000
      const status = options.status ?? "completed"
      if (durable) await durable.cleanQueue(name, graceMs, limit, status)
      else await getQueue(name).clean(graceMs, limit, status)
    },
  }
}
