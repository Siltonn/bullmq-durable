/**
 * Zod schemas for request validation (query strings + bodies).
 *
 * Response shapes live in `../shared/dto.ts`; this file only validates what
 * comes *in*. Query params arrive as strings, so numeric/boolean fields use
 * coercion, and booleans use an explicit `"true"` check (z.coerce.boolean would
 * treat any non-empty string — including `"false"` — as `true`).
 */

import { z } from "zod"

/** A query-string boolean that is only true for the literal string `"true"`. */
const queryBool = z
  .preprocess((value) => value === "true" || value === true, z.boolean())
  .optional()

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(50),
})

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

export const jobListQuerySchema = paginationSchema.extend({
  status: jobStateSchema.optional(),
  jobName: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
})

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

export const durableListQuerySchema = paginationSchema.extend({
  status: durableStatusSchema.optional(),
  queue: z.string().min(1).optional(),
  jobName: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  stuckOnly: queryBool,
  sort: z.enum(["updatedAt", "createdAt", "duration"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const addJobBodySchema = z.object({
  name: z.string().min(1).max(200),
  data: z.unknown().optional(),
  delay: z.coerce.number().int().min(0).optional(),
  priority: z.coerce.number().int().min(0).optional(),
  attempts: z.coerce.number().int().min(1).max(100).optional(),
  jobId: z.string().min(1).max(255).optional(),
})

export const addSchedulerBodySchema = z
  .object({
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

export const bulkJobsBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000),
})

export const cleanBodySchema = z.object({
  graceMs: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100000).optional(),
  status: z
    .enum(["completed", "failed", "delayed", "active", "paused", "wait", "prioritized"])
    .optional(),
})

export const stuckQuerySchema = z.object({
  thresholdMs: z.coerce.number().int().min(0).optional(),
})

export const alertRuleBodySchema = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  metric: z.enum(["failed", "backlog", "waiting", "active", "no_workers", "stuck"]),
  queue: z.string().min(1).max(200).optional(),
  operator: z.enum(["gt", "gte", "lt", "lte"]).default("gt"),
  threshold: z.coerce.number().min(0).max(1_000_000).default(0),
  enabled: z.boolean().default(true),
  channels: z.array(z.string().min(1)).max(20).default([]),
})

export const alertChannelBodySchema = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  type: z.enum(["webhook", "slack"]).default("webhook"),
  url: z.string().url().max(2000),
})

export type JobListQueryInput = z.infer<typeof jobListQuerySchema>
export type DurableListQueryInput = z.infer<typeof durableListQuerySchema>
export type CleanBodyInput = z.infer<typeof cleanBodySchema>
