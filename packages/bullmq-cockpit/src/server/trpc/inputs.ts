/**
 * Zod input schemas for every tRPC procedure — the single source of truth for
 * what each call accepts. tRPC validates against these and *infers* the input
 * types the client sees, so there is no hand-written client contract to drift.
 *
 * Path parameters that used to live in the URL (`queueName`, `jobId`,
 * `instanceId`, …) are now ordinary fields on the input object; the query/body
 * fields are unchanged from the old REST contract. Numeric fields stay coerced
 * (query strings historically arrived as strings, and coercion keeps callers
 * that pass either a number or a numeric string working).
 */

import { z } from "zod"

// --- shared field fragments -------------------------------------------------

const queueName = z.string().min(1)
const jobId = z.string().min(1)
const instanceId = z.string().min(1)

/** `{ queueName }` — the base for every queue-scoped procedure. */
export const queueParam = z.object({ queueName })
/** `{ queueName, jobId }` — the base for every job-scoped procedure. */
export const jobParam = z.object({ queueName, jobId })
/** `{ instanceId }` — the base for every durable-instance procedure. */
export const instanceParam = z.object({ instanceId })

const pagination = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(50),
})

/** Optional `windowMinutes`, clamped to a sane range by the resolver. */
const windowMinutes = z.coerce.number().int().min(1).optional()

// --- overview ---------------------------------------------------------------

export const signalsInput = z.object({ windowMinutes })

// --- queues -----------------------------------------------------------------

export const queueActivityInput = queueParam.extend({ windowMinutes })

export const cleanQueueInput = queueParam.extend({
  graceMs: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100000).optional(),
  status: z
    .enum(["completed", "failed", "delayed", "active", "paused", "wait", "prioritized"])
    .optional(),
})

// --- jobs -------------------------------------------------------------------

export const jobStateSchema = z.enum([
  "waiting",
  "waiting-children",
  "active",
  "completed",
  "failed",
  "delayed",
  "paused",
  "prioritized",
  "all",
])

export const jobListInput = queueParam.extend(pagination.shape).extend({
  status: jobStateSchema.optional(),
  jobName: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
})

export const addJobInput = queueParam.extend({
  name: z.string().min(1).max(200),
  data: z.unknown().optional(),
  delay: z.coerce.number().int().min(0).optional(),
  priority: z.coerce.number().int().min(0).optional(),
  attempts: z.coerce.number().int().min(1).max(100).optional(),
  jobId: z.string().min(1).max(255).optional(),
})

export const bulkJobsInput = queueParam.extend({
  ids: z.array(z.string().min(1)).min(1).max(1000),
})

// --- schedulers -------------------------------------------------------------

export const addSchedulerInput = queueParam
  .extend({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200).optional(),
    pattern: z.string().min(1).max(200).optional(),
    every: z.coerce.number().int().min(1000).optional(),
    tz: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).optional(),
    data: z.unknown().optional(),
  })
  .refine((v) => Boolean(v.pattern) || Boolean(v.every), {
    message: "Provide a cron pattern or an interval (every)",
  })

export const removeSchedulerInput = queueParam.extend({ id: z.string().min(1) })

// --- durable ----------------------------------------------------------------

export const durableStatusSchema = z.enum([
  "running",
  "sleeping",
  "retrying",
  "waiting",
  "compensating",
  "completed",
  "failed",
  "compensation_failed",
  "cancelled",
  "all",
])

export const durableListInput = pagination.extend({
  status: durableStatusSchema.optional(),
  queue: z.string().min(1).optional(),
  jobName: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  stuckOnly: z.boolean().optional(),
  sort: z.enum(["updatedAt", "createdAt", "duration"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

// --- alerts -----------------------------------------------------------------

export const idInput = z.object({ id: z.string().min(1) })

export const saveAlertRuleInput = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  metric: z.enum(["failed", "backlog", "waiting", "active", "no_workers", "stuck"]),
  queue: z.string().min(1).max(200).optional(),
  operator: z.enum(["gt", "gte", "lt", "lte"]).default("gt"),
  threshold: z.coerce.number().min(0).max(1_000_000).default(0),
  enabled: z.boolean().default(true),
  channels: z.array(z.string().min(1)).max(20).default([]),
})

export const saveAlertChannelInput = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  type: z.enum(["webhook", "slack"]).default("webhook"),
  url: z.string().url().max(2000),
})

// --- health -----------------------------------------------------------------

export const stuckInput = z.object({
  thresholdMs: z.coerce.number().int().min(0).optional(),
})
