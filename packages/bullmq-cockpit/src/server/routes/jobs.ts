/**
 * `/api/queues/:queueName/jobs` — job listing, detail, logs, dependencies, and
 * actions. Mounted at the same base as the queue routes.
 */

import { Hono } from "hono"
import type { ActionResult } from "../../shared/dto"
import { requirePermission, type CockpitVariables } from "../middleware/auth"
import { addJobBodySchema, bulkJobsBodySchema, jobListQuerySchema } from "../http/contracts"
import type { BoardContext } from "../context"
import { notFound } from "../http/http-error"
import { parseBody, parseQuery } from "../http/validate"

const ok: ActionResult = { ok: true }

export function jobRoutes(ctx: BoardContext): Hono<{ Variables: CockpitVariables }> {
  const app = new Hono<{ Variables: CockpitVariables }>()

  app.get("/:queueName/jobs", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:read")
    const query = parseQuery(jobListQuerySchema, c)
    const result = await ctx.bullmq.listJobs(c.req.param("queueName"), query)
    return c.json(result)
  })

  app.post("/:queueName/jobs", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:write")
    const body = await parseBody(addJobBodySchema, c)
    const { id } = await ctx.bullmq.addJob(c.req.param("queueName"), body)
    return c.json({ ok: true, message: `Job ${id} added` } satisfies ActionResult)
  })

  app.get("/:queueName/jobs/:jobId", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:read")
    const detail = await ctx.bullmq.getJob(c.req.param("queueName"), c.req.param("jobId"))
    if (!detail) throw notFound(`Job "${c.req.param("jobId")}" not found`)
    return c.json(detail)
  })

  app.get("/:queueName/jobs/:jobId/logs", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:read")
    return c.json(await ctx.bullmq.getJobLogs(c.req.param("queueName"), c.req.param("jobId")))
  })

  app.get("/:queueName/jobs/:jobId/dependencies", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:read")
    const deps = await ctx.bullmq.getJobDependencies(c.req.param("queueName"), c.req.param("jobId"))
    if (!deps) throw notFound(`Job "${c.req.param("jobId")}" not found`)
    return c.json(deps)
  })

  app.get("/:queueName/jobs/:jobId/flow", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:read")
    const flow = await ctx.bullmq.getJobFlow(c.req.param("queueName"), c.req.param("jobId"))
    if (!flow) throw notFound(`Job "${c.req.param("jobId")}" not found`)
    return c.json(flow)
  })

  app.post("/:queueName/jobs/:jobId/duplicate", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:write")
    const { id } = await ctx.bullmq.duplicateJob(c.req.param("queueName"), c.req.param("jobId"))
    return c.json({ ok: true, message: `Duplicated as job ${id}` } satisfies ActionResult)
  })

  app.post("/:queueName/jobs/:jobId/retry", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:write")
    await ctx.bullmq.retryJob(c.req.param("queueName"), c.req.param("jobId"))
    return c.json(ok)
  })

  app.post("/:queueName/jobs/:jobId/promote", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:write")
    await ctx.bullmq.promoteJob(c.req.param("queueName"), c.req.param("jobId"))
    return c.json(ok)
  })

  app.post("/:queueName/jobs/:jobId/remove", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:write")
    await ctx.bullmq.removeJob(c.req.param("queueName"), c.req.param("jobId"))
    return c.json(ok)
  })

  // Bulk actions live under `/bulk` (not `/jobs/...`) to avoid colliding with
  // the `:jobId` routes above.
  app.post("/:queueName/bulk/retry", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:write")
    const { ids } = await parseBody(bulkJobsBodySchema, c)
    const result = await ctx.bullmq.retryJobs(c.req.param("queueName"), ids)
    return c.json({ ok: true, message: `Retried ${result.ok} job(s)` } satisfies ActionResult)
  })

  app.post("/:queueName/bulk/remove", async (c) => {
    requirePermission(ctx, c.get("permissions"), "job:write")
    const { ids } = await parseBody(bulkJobsBodySchema, c)
    const result = await ctx.bullmq.removeJobs(c.req.param("queueName"), ids)
    return c.json({ ok: true, message: `Removed ${result.ok} job(s)` } satisfies ActionResult)
  })

  return app
}
