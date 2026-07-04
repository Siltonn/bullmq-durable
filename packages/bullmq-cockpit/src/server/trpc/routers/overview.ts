/** `overview` — the dashboard landing aggregate + system-wide golden signals. */

import type { JobCounts, OverviewStats, QueueSummary } from "../../../shared/dto"
import { signalsInput } from "../inputs"
import { protectedProcedure, router } from "../trpc"

function sumCounts(all: JobCounts[]): JobCounts {
  return all.reduce<JobCounts>(
    (acc, c) => ({
      waiting: acc.waiting + c.waiting,
      active: acc.active + c.active,
      completed: acc.completed + c.completed,
      failed: acc.failed + c.failed,
      delayed: acc.delayed + c.delayed,
      paused: acc.paused + c.paused,
      prioritized: acc.prioritized + c.prioritized,
      "waiting-children": acc["waiting-children"] + c["waiting-children"],
    }),
    {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
      prioritized: 0,
      "waiting-children": 0,
    },
  )
}

/** Rank queues by "live" work first so the overview surfaces the busy ones. */
function busyness(q: QueueSummary): number {
  return q.counts.active * 3 + q.counts.waiting + q.counts.delayed + q.counts.failed * 2
}

/** Clamp a caller-supplied window to a sane range (defaults to 30 minutes). */
function clampWindow(windowMinutes: number | undefined): number {
  return windowMinutes && windowMinutes > 0 ? Math.min(720, windowMinutes) : 30
}

export const overviewRouter = router({
  stats: protectedProcedure("queue:read").query(async ({ ctx }): Promise<OverviewStats> => {
    const queues = await ctx.board.bullmq.listQueues()
    const durable = ctx.board.durable ? await ctx.board.durable.statusCounts() : undefined
    const topQueues = [...queues].sort((a, b) => busyness(b) - busyness(a)).slice(0, 6)

    return {
      queues: queues.length,
      jobs: sumCounts(queues.map((q) => q.counts)),
      durable,
      topQueues,
      generatedAt: Date.now(),
    }
  }),

  // System-wide golden signals (traffic / latency / errors / saturation).
  signals: protectedProcedure("queue:read")
    .input(signalsInput)
    .query(({ ctx, input }) => ctx.board.bullmq.systemSignals(clampWindow(input.windowMinutes))),
})
