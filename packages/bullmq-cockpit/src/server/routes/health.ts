/** `/api/health` — connection health and durable stuck detection. */

import { Hono } from "hono"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import { stuckQuerySchema } from "../http/contracts"
import type { BoardContext } from "../context"
import { parseQuery } from "../http/validate"

export function healthRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  app.get("/", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    return c.json(await ctx.health.health())
  })

  app.get("/redis", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    return c.json(await ctx.bullmq.redisInfo())
  })

  app.get("/stuck", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:read")
    const { thresholdMs } = parseQuery(stuckQuerySchema, c)
    return c.json(await ctx.health.stuck(thresholdMs))
  })

  return app
}
