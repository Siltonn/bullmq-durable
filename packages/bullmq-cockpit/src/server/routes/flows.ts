/** `/api/flows` — active FlowProducer roots (parents waiting on children). */

import { Hono } from "hono"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import type { BoardContext } from "../context"

export function flowRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  app.get("/", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:read")
    return c.json(await ctx.bullmq.listFlows())
  })

  return app
}
