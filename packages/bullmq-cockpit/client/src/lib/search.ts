/**
 * URL-search schemas for the list pages. Keeping filter / pagination / sort
 * state in the URL makes every view shareable and back-button friendly (RFC §17).
 * TanStack Router parses search values for us; the `.catch` defaults keep a
 * malformed URL from throwing.
 */

import { z } from "zod"

export const jobsSearchSchema = z.object({
  queue: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(50),
})

export type JobsSearch = z.infer<typeof jobsSearchSchema>

export const durableSearchSchema = z.object({
  status: z.string().optional(),
  queue: z.string().optional(),
  search: z.string().optional(),
  stuckOnly: z.boolean().optional(),
  sort: z.enum(["updatedAt", "createdAt", "duration"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(50),
})

export type DurableSearch = z.infer<typeof durableSearchSchema>
