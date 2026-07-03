/** `alerts` — cockpit alert rules, channels, and live evaluation. */

import type { ActionResult } from "../../../shared/dto"
import { idInput, saveAlertChannelInput, saveAlertRuleInput } from "../inputs"
import { protectedProcedure, router } from "../trpc"

const ok: ActionResult = { ok: true }

export const alertsRouter = router({
  // Live evaluation of every rule (the dashboard).
  overview: protectedProcedure("queue:read").query(({ ctx }) => ctx.board.alerts.overview()),

  // -- Rules ---------------------------------------------------------------

  listRules: protectedProcedure("queue:read").query(({ ctx }) => ctx.board.alerts.listRules()),

  saveRule: protectedProcedure("queue:write")
    .input(saveAlertRuleInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      const rule = await ctx.board.alerts.saveRule(input)
      return { ok: true, id: rule.id }
    }),

  removeRule: protectedProcedure("queue:write")
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.alerts.removeRule(input.id)
      return ok
    }),

  toggleRule: protectedProcedure("queue:write")
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.alerts.toggleRule(input.id)
      return ok
    }),

  // -- Channels ------------------------------------------------------------

  listChannels: protectedProcedure("queue:read").query(({ ctx }) =>
    ctx.board.alerts.listChannels(),
  ),

  saveChannel: protectedProcedure("queue:write")
    .input(saveAlertChannelInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      const channel = await ctx.board.alerts.saveChannel(input)
      return { ok: true, id: channel.id }
    }),

  removeChannel: protectedProcedure("queue:write")
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await ctx.board.alerts.removeChannel(input.id)
      return ok
    }),

  testChannel: protectedProcedure("queue:write")
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      const delivered = await ctx.board.alerts.testChannel(input.id)
      return {
        ok: delivered,
        message: delivered
          ? "Test notification delivered"
          : "Channel did not accept the request",
      }
    }),
})
