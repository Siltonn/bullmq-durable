/** `/api/queues` — queue listing, detail, and lifecycle actions. */

import { Hono } from "hono"
import type { ActionResult } from "../../shared/dto"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import { cleanBodySchema } from "../http/contracts"
import type { BoardContext } from "../context"
import { notFound } from "../http/http-error"
import { parseBody } from "../http/validate"

const ok: ActionResult = { ok: true }

export function queueRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  app.get("/", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    return c.json(await ctx.bullmq.listQueues())
  })

  app.get("/:queueName", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    const detail = await ctx.bullmq.getQueueDetail(c.req.param("queueName"))
    if (!detail) throw notFound(`Queue "${c.req.param("queueName")}" not found`)
    return c.json(detail)
  })

  app.get("/:queueName/metrics", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    return c.json(await ctx.bullmq.getMetrics(c.req.param("queueName")))
  })

  // Derived activity: throughput + latency + per-job-name, from recent jobs.
  app.get("/:queueName/activity", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    const window = Number(c.req.query("windowMinutes"))
    const windowMinutes = Number.isFinite(window) && window > 0 ? Math.min(720, window) : 30
    return c.json(await ctx.bullmq.queueActivity(c.req.param("queueName"), windowMinutes))
  })

  app.post("/:queueName/pause", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    await ctx.bullmq.pauseQueue(c.req.param("queueName"))
    return c.json(ok)
  })

  app.post("/:queueName/resume", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    await ctx.bullmq.resumeQueue(c.req.param("queueName"))
    return c.json(ok)
  })

  app.post("/:queueName/clean", async (c) => {
    // Cleaning permanently removes jobs — gate it behind the dangerous scope.
    requirePermission(ctx, c.get("permissions"), "dangerous:write")
    const body = await parseBody(cleanBodySchema, c)
    await ctx.bullmq.cleanQueue(c.req.param("queueName"), body)
    return c.json(ok)
  })

  app.post("/:queueName/drain", async (c) => {
    requirePermission(ctx, c.get("permissions"), "dangerous:write")
    await ctx.bullmq.drainQueue(c.req.param("queueName"))
    return c.json(ok)
  })

  return app
}
