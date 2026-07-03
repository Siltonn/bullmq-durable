/** `config` — the bootstrap payload the SPA reads on load. */

import { buildCockpitConfig } from "../../config"
import { authedProcedure, router } from "../trpc"

export const configRouter = router({
  get: authedProcedure.query(({ ctx }) =>
    buildCockpitConfig(ctx.board, ctx.permissions, ctx.user),
  ),
})
