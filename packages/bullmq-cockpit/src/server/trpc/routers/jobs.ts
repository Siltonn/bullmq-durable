/** `jobs` — job listing, detail, logs, dependencies, flow, and actions. */

import type { ActionResult } from "../../../shared/dto"
import { notFound } from "../../http/http-error"
import { addJobInput, bulkJobsInput, jobListInput, jobParam } from "../inputs"
import { protectedProcedure, router } from "../trpc"

const ok: ActionResult = { ok: true }

export const jobsRouter = router({
  list: protectedProcedure("job:read")
    .input(jobListInput)
    .query(async ({ ctx, input }) => {
      const { queueName, ...query } = input
      await ctx.board.requireQueue(queueName)
      return ctx.board.bullmq.listJobs(queueName, query)
    }),

  add: protectedProcedure("job:write")
    .input(addJobInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      const { queueName, ...body } = input
      await ctx.board.requireQueue(queueName)
      const { id } = await ctx.board.bullmq.addJob(queueName, body)
      return { ok: true, message: `Job ${id} added` }
    }),

  get: protectedProcedure("job:read")
    .input(jobParam)
    .query(async ({ ctx, input }) => {
      await ctx.board.requireQueue(input.queueName)
      const detail = await ctx.board.bullmq.getJob(input.queueName, input.jobId)
      if (!detail) throw notFound(`Job "${input.jobId}" not found`)
      return detail
    }),

  logs: protectedProcedure("job:read")
    .input(jobParam)
    .query(async ({ ctx, input }) => {
      await ctx.board.requireQueue(input.queueName)
      return ctx.board.bullmq.getJobLogs(input.queueName, input.jobId)
    }),

  dependencies: protectedProcedure("job:read")
    .input(jobParam)
    .query(async ({ ctx, input }) => {
      await ctx.board.requireQueue(input.queueName)
      const deps = await ctx.board.bullmq.getJobDependencies(input.queueName, input.jobId)
      if (!deps) throw notFound(`Job "${input.jobId}" not found`)
      return deps
    }),

  flow: protectedProcedure("job:read")
    .input(jobParam)
    .query(async ({ ctx, input }) => {
      await ctx.board.requireQueue(input.queueName)
      const flow = await ctx.board.bullmq.getJobFlow(input.queueName, input.jobId)
      if (!flow) throw notFound(`Job "${input.jobId}" not found`)
      return flow
    }),

  duplicate: protectedProcedure("job:write")
    .input(jobParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      const { id } = await ctx.board.bullmq.duplicateJob(input.queueName, input.jobId)
      return { ok: true, message: `Duplicated as job ${id}` }
    }),

  retry: protectedProcedure("job:write")
    .input(jobParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      await ctx.board.bullmq.retryJob(input.queueName, input.jobId)
      return ok
    }),

  promote: protectedProcedure("job:write")
    .input(jobParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      await ctx.board.bullmq.promoteJob(input.queueName, input.jobId)
      return ok
    }),

  remove: protectedProcedure("job:write")
    .input(jobParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      await ctx.board.bullmq.removeJob(input.queueName, input.jobId)
      return ok
    }),

  bulkRetry: protectedProcedure("job:write")
    .input(bulkJobsInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      const result = await ctx.board.bullmq.retryJobs(input.queueName, input.ids)
      return { ok: true, message: `Retried ${result.ok} job(s)` }
    }),

  bulkRemove: protectedProcedure("job:write")
    .input(bulkJobsInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      const result = await ctx.board.bullmq.removeJobs(input.queueName, input.ids)
      return { ok: true, message: `Removed ${result.ok} job(s)` }
    }),
})
