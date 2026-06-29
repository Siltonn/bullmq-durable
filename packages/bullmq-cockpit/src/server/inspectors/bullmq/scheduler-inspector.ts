/** Schedulers (repeatable / cron jobs). */

import type { SchedulerSummary } from "../../../shared/dto"
import { type BullMQInspectorDeps, resolveQueueNames } from "./shared"

export function createSchedulerInspector(deps: BullMQInspectorDeps) {
  const { getQueue } = deps

  const listSchedulers = async (queueName: string): Promise<SchedulerSummary[]> => {
    const queue = getQueue(queueName)
    const get = (queue as unknown as { getJobSchedulers?: GetSchedulers }).getJobSchedulers
    const raw =
      typeof get === "function"
        ? await get.call(queue, 0, -1, true).catch(() => [])
        : await (queue as unknown as { getRepeatableJobs?: () => Promise<RawScheduler[]> })
            .getRepeatableJobs?.()
            .catch(() => [])
    return (raw ?? []).map((s) => normalizeScheduler(s, queueName))
  }

  return {
    listSchedulers,

    async listAllSchedulers(): Promise<SchedulerSummary[]> {
      const names = await resolveQueueNames(deps)
      const all = await Promise.all(names.map((n) => listSchedulers(n).catch(() => [])))
      return all
        .flat()
        .sort((a, b) => (a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY))
    },

    async addScheduler(
      queueName: string,
      input: {
        id: string
        name?: string
        pattern?: string
        every?: number
        tz?: string
        limit?: number
        data?: unknown
      },
    ): Promise<void> {
      const queue = getQueue(queueName)
      const repeat: Record<string, unknown> = {}
      if (input.pattern) repeat.pattern = input.pattern
      if (input.every) repeat.every = input.every
      if (input.tz) repeat.tz = input.tz
      if (input.limit) repeat.limit = input.limit

      const upsert = (queue as unknown as { upsertJobScheduler?: UpsertScheduler })
        .upsertJobScheduler
      if (typeof upsert === "function") {
        await upsert.call(queue, input.id, repeat, {
          name: input.name ?? input.id,
          data: input.data ?? {},
        })
        return
      }
      // Legacy fallback: a repeatable job.
      await queue.add(input.name ?? input.id, input.data ?? {}, {
        repeat: repeat as never,
        jobId: input.id,
      })
    },

    async removeScheduler(queueName: string, schedulerId: string): Promise<void> {
      const queue = getQueue(queueName)
      const remove = (queue as unknown as { removeJobScheduler?: (id: string) => Promise<boolean> })
        .removeJobScheduler
      if (typeof remove === "function") {
        await remove.call(queue, schedulerId)
        return
      }
      await (queue as unknown as { removeRepeatableByKey?: (k: string) => Promise<boolean> })
        .removeRepeatableByKey?.(schedulerId)
        .catch(() => undefined)
    },
  }
}

// BullMQ's scheduler APIs vary slightly across 5.x minors, so we call them
// through narrow structural types rather than depending on exact exports.
interface RawScheduler {
  key?: string
  id?: string | null
  name?: string
  pattern?: string | null
  every?: string | number | null
  tz?: string | null
  next?: number | null
  endDate?: number | null
  limit?: number | null
  template?: { data?: unknown; opts?: Record<string, unknown> } | null
}
type GetSchedulers = (start?: number, end?: number, asc?: boolean) => Promise<RawScheduler[]>
type UpsertScheduler = (
  id: string,
  repeat: Record<string, unknown>,
  template?: { name?: string; data?: unknown },
) => Promise<unknown>

function normalizeScheduler(s: RawScheduler, queueName: string): SchedulerSummary {
  const everyNum = s.every != null ? Number(s.every) : Number.NaN
  return {
    key: String(s.key ?? s.id ?? ""),
    id: String(s.id ?? s.key ?? ""),
    name: String(s.name ?? s.id ?? s.key ?? ""),
    queueName,
    pattern: s.pattern ?? undefined,
    every: Number.isFinite(everyNum) && everyNum > 0 ? everyNum : undefined,
    tz: s.tz ?? undefined,
    next: s.next ?? undefined,
    endDate: s.endDate ?? undefined,
    limit: s.limit ?? undefined,
    template: s.template ?? undefined,
  }
}
