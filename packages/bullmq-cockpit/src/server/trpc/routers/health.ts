/** `health` — connection health, Redis info, and durable stuck detection. */

import { stuckInput } from "../inputs"
import { protectedProcedure, router } from "../trpc"

export const healthRouter = router({
  health: protectedProcedure("queue:read").query(({ ctx }) => ctx.board.health.health()),

  redis: protectedProcedure("queue:read").query(({ ctx }) => ctx.board.bullmq.redisInfo()),

  stuck: protectedProcedure("durable:read")
    .input(stuckInput)
    .query(({ ctx, input }) => ctx.board.health.stuck(input.thresholdMs)),
})
