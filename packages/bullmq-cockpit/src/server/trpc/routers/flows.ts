/** `flows` — active FlowProducer roots (parents waiting on children). */

import { protectedProcedure, router } from "../trpc"

export const flowsRouter = router({
  list: protectedProcedure("job:read").query(({ ctx }) => ctx.board.bullmq.listFlows()),
})
