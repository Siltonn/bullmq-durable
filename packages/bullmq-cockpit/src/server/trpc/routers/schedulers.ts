/** `schedulers` — BullMQ job schedulers (repeatable / cron jobs). */

import type { ActionResult } from "../../../shared/dto"
import { addSchedulerInput, queueParam, removeSchedulerInput } from "../inputs"
import { protectedProcedure, router } from "../trpc"

const ok: ActionResult = { ok: true }

export const schedulersRouter = router({
  list: protectedProcedure("queue:read").query(({ ctx }) =>
    ctx.board.bullmq.listAllSchedulers(),
  ),

  listForQueue: protectedProcedure("queue:read")
    .input(queueParam)
    .query(({ ctx, input }) => ctx.board.bullmq.listSchedulers(input.queueName)),

  add: protectedProcedure("queue:write")
    .input(addSchedulerInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      const { queueName, ...body } = input
      await ctx.board.bullmq.addScheduler(queueName, body)
      return ok
    }),

  remove: protectedProcedure("queue:write")
    .input(removeSchedulerInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.bullmq.removeScheduler(input.queueName, input.id)
      return ok
    }),
})
