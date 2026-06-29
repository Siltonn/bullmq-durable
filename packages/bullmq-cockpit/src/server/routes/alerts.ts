/** `/api/alerts` — cockpit alert rules, channels, and live evaluation. */

import { Hono } from "hono"
import type { ActionResult } from "../../shared/dto"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import { alertChannelBodySchema, alertRuleBodySchema } from "../http/contracts"
import type { BoardContext } from "../context"
import { parseBody } from "../http/validate"

const ok: ActionResult = { ok: true }

export function alertRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  const alerts = () => {
    if (!ctx.alerts) {
      return { missing: true as const }
    }
    return { missing: false as const, svc: ctx.alerts }
  }

  // Live evaluation of every rule (the dashboard).
  app.get("/", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    const a = alerts()
    if (a.missing) return c.json({ evaluations: [], firing: 0, total: 0, channels: 0 })
    return c.json(await a.svc.overview())
  })

  // -- Rules ---------------------------------------------------------------

  app.get("/rules", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    const a = alerts()
    return c.json(a.missing ? [] : await a.svc.listRules())
  })

  app.post("/rules", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    const a = alerts()
    if (a.missing) return c.json(ok)
    const body = await parseBody(alertRuleBodySchema, c)
    const rule = await a.svc.saveRule(body)
    return c.json({ ok: true, id: rule.id } satisfies ActionResult)
  })

  app.post("/rules/:id/remove", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    const a = alerts()
    if (!a.missing) await a.svc.removeRule(c.req.param("id"))
    return c.json(ok)
  })

  app.post("/rules/:id/toggle", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    const a = alerts()
    if (!a.missing) await a.svc.toggleRule(c.req.param("id"))
    return c.json(ok)
  })

  // -- Channels ------------------------------------------------------------

  app.get("/channels", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:read")
    const a = alerts()
    return c.json(a.missing ? [] : await a.svc.listChannels())
  })

  app.post("/channels", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    const a = alerts()
    if (a.missing) return c.json(ok)
    const body = await parseBody(alertChannelBodySchema, c)
    const channel = await a.svc.saveChannel(body)
    return c.json({ ok: true, id: channel.id } satisfies ActionResult)
  })

  app.post("/channels/:id/remove", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    const a = alerts()
    if (!a.missing) await a.svc.removeChannel(c.req.param("id"))
    return c.json(ok)
  })

  app.post("/channels/:id/test", async (c) => {
    requirePermission(ctx, c.get("permissions"), "queue:write")
    const a = alerts()
    if (a.missing) return c.json({ ok: false, message: "Alerts disabled" } satisfies ActionResult)
    const delivered = await a.svc.testChannel(c.req.param("id"))
    return c.json({
      ok: delivered,
      message: delivered ? "Test notification delivered" : "Channel did not accept the request",
    } satisfies ActionResult)
  })

  return app
}
