/** `GET /api/overview` — the dashboard landing aggregate. */

import { Hono } from "hono"
import type { JobCounts, OverviewStats, QueueSummary } from "../../shared/dto"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import type { BoardContext } from "../context"

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

export function overviewRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  app.get("/", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")

    const queues = await ctx.bullmq.listQueues()
    const durable = ctx.durable ? await ctx.durable.statusCounts() : undefined
    const topQueues = [...queues].sort((a, b) => busyness(b) - busyness(a)).slice(0, 6)

    const stats: OverviewStats = {
      queues: queues.length,
      jobs: sumCounts(queues.map((q) => q.counts)),
      durable,
      topQueues,
      generatedAt: Date.now(),
    }
    return c.json(stats)
  })

  // System-wide golden signals (traffic / latency / errors / saturation).
  app.get("/signals", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    const window = Number(c.req.query("windowMinutes"))
    const windowMinutes = Number.isFinite(window) && window > 0 ? Math.min(720, window) : 30
    return c.json(await ctx.bullmq.systemSignals(windowMinutes))
  })

  return app
}
