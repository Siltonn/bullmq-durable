/** `/api/schedulers` — BullMQ job schedulers (repeatable / cron jobs). */

import { Hono } from "hono"
import type { ActionResult } from "../../shared/dto"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import { addSchedulerBodySchema } from "../http/contracts"
import type { BoardContext } from "../context"
import { parseBody } from "../http/validate"

const ok: ActionResult = { ok: true }

export function schedulerRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  app.get("/", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    return c.json(await ctx.bullmq.listAllSchedulers())
  })

  app.get("/:queueName", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    return c.json(await ctx.bullmq.listSchedulers(c.req.param("queueName")))
  })

  app.post("/:queueName", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    const body = await parseBody(addSchedulerBodySchema, c)
    await ctx.bullmq.addScheduler(c.req.param("queueName"), body)
    return c.json(ok)
  })

  app.post("/:queueName/:id/remove", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    await ctx.bullmq.removeScheduler(c.req.param("queueName"), c.req.param("id"))
    return c.json(ok)
  })

  return app
}
