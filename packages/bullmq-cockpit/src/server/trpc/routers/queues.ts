/** `queues` — queue listing, detail, metrics, activity, and lifecycle actions. */

import type { ActionResult } from "../../../shared/dto"
import { notFound } from "../../http/http-error"
import { cleanQueueInput, queueActivityInput, queueParam } from "../inputs"
import { protectedProcedure, router } from "../trpc"

const ok: ActionResult = { ok: true }

export const queuesRouter = router({
  list: protectedProcedure("queue:read").query(({ ctx }) => ctx.board.bullmq.listQueues()),

  get: protectedProcedure("queue:read")
    .input(queueParam)
    .query(async ({ ctx, input }) => {
      const detail = await ctx.board.bullmq.getQueueDetail(input.queueName)
      if (!detail) throw notFound(`Queue "${input.queueName}" not found`)
      return detail
    }),

  metrics: protectedProcedure("queue:read")
    .input(queueParam)
    .query(async ({ ctx, input }) => {
      await ctx.board.requireQueue(input.queueName)
      return ctx.board.bullmq.getMetrics(input.queueName)
    }),

  // Derived activity: throughput + latency + per-job-name, from recent jobs.
  activity: protectedProcedure("queue:read")
    .input(queueActivityInput)
    .query(async ({ ctx, input }) => {
      await ctx.board.requireQueue(input.queueName)
      const w = input.windowMinutes
      const windowMinutes = w && w > 0 ? Math.min(720, w) : 30
      return ctx.board.bullmq.queueActivity(input.queueName, windowMinutes)
    }),

  pause: protectedProcedure("queue:write")
    .input(queueParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      await ctx.board.bullmq.pauseQueue(input.queueName)
      return ok
    }),

  resume: protectedProcedure("queue:write")
    .input(queueParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      await ctx.board.bullmq.resumeQueue(input.queueName)
      return ok
    }),

  // Cleaning permanently removes jobs — gate it behind the dangerous scope.
  clean: protectedProcedure("dangerous:write")
    .input(cleanQueueInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      const { queueName, ...body } = input
      await ctx.board.requireQueue(queueName)
      await ctx.board.bullmq.cleanQueue(queueName, body)
      return ok
    }),

  drain: protectedProcedure("dangerous:write")
    .input(queueParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.requireQueue(input.queueName)
      await ctx.board.bullmq.drainQueue(input.queueName)
      return ok
    }),
})
