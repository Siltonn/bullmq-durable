/**
 * `/api/durable` — the durable instance inspector.
 *
 * Every handler first resolves the durable inspector; if the cockpit was started
 * without durable support, the whole namespace answers `404 durable_disabled`.
 */

import { Hono } from "hono"
import type { ActionResult } from "../../shared/dto"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import { durableListQuerySchema } from "../http/contracts"
import type { BoardContext } from "../context"
import { HttpError, notFound } from "../http/http-error"
import type { DurableInspector } from "../inspectors/durable-inspector"
import { parseQuery } from "../http/validate"

const ok: ActionResult = { ok: true }

function requireDurable(ctx: BoardContext): DurableInspector {
  if (!ctx.durable) {
    throw new HttpError(404, "Durable inspector is not enabled", "durable_disabled")
  }
  return ctx.durable
}

export function durableRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  app.get("/instances", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:read")
    const durable = requireDurable(ctx)
    const query = parseQuery(durableListQuerySchema, c)
    return c.json(await durable.listInstances(query))
  })

  app.get("/instances/:instanceId", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:read")
    const durable = requireDurable(ctx)
    const detail = await durable.getInstance(c.req.param("instanceId"))
    if (!detail) throw notFound(`Durable instance "${c.req.param("instanceId")}" not found`)
    return c.json(detail)
  })

  app.get("/instances/:instanceId/steps", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:read")
    return c.json(await requireDurable(ctx).getSteps(c.req.param("instanceId")))
  })

  app.get("/instances/:instanceId/events", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:read")
    return c.json(await requireDurable(ctx).getEvents(c.req.param("instanceId")))
  })

  app.get("/instances/:instanceId/logs", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:read")
    return c.json(await requireDurable(ctx).getLogs(c.req.param("instanceId")))
  })

  app.post("/instances/:instanceId/resume", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:resume")
    await requireDurable(ctx).resumeNow(c.req.param("instanceId"))
    return c.json(ok)
  })

  app.post("/instances/:instanceId/retry", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:retry")
    await requireDurable(ctx).retry(c.req.param("instanceId"))
    return c.json(ok)
  })

  app.post("/instances/:instanceId/retry-compensation", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:retry")
    await requireDurable(ctx).retryCompensation(c.req.param("instanceId"))
    return c.json(ok)
  })

  app.post("/instances/:instanceId/cancel", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:cancel")
    await requireDurable(ctx).cancel(c.req.param("instanceId"))
    return c.json(ok)
  })

  app.post("/instances/:instanceId/delete", async (c) => {
    requirePermission(ctx, c.get("permissions"), "durable:delete")
    await requireDurable(ctx).deleteState(c.req.param("instanceId"))
    return c.json(ok)
  })

  return app
}
