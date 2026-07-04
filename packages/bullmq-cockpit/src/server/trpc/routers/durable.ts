/**
 * `durable` — the durable instance inspector.
 *
 * Every procedure first resolves the durable inspector; if the cockpit was
 * started without durable support, the whole namespace answers a `404` (mapped
 * from the same `durable_disabled` error the REST routes used).
 */

import type { ActionResult } from "../../../shared/dto"
import type { CockpitContext } from "../trpc"
import { HttpError, notFound } from "../../http/http-error"
import type { DurableInspector } from "../../inspectors/durable-inspector"
import { durableListInput, instanceParam } from "../inputs"
import { protectedProcedure, router } from "../trpc"

const ok: ActionResult = { ok: true }

function requireDurable(ctx: CockpitContext): DurableInspector {
  if (!ctx.board.durable) {
    throw new HttpError(404, "Durable inspector is not enabled", "durable_disabled")
  }
  return ctx.board.durable
}

export const durableRouter = router({
  list: protectedProcedure("durable:read")
    .input(durableListInput)
    .query(({ ctx, input }) => requireDurable(ctx).listInstances(input)),

  get: protectedProcedure("durable:read")
    .input(instanceParam)
    .query(async ({ ctx, input }) => {
      const detail = await requireDurable(ctx).getInstance(input.instanceId)
      if (!detail) throw notFound(`Durable instance "${input.instanceId}" not found`)
      return detail
    }),

  steps: protectedProcedure("durable:read")
    .input(instanceParam)
    .query(({ ctx, input }) => requireDurable(ctx).getSteps(input.instanceId)),

  events: protectedProcedure("durable:read")
    .input(instanceParam)
    .query(({ ctx, input }) => requireDurable(ctx).getEvents(input.instanceId)),

  logs: protectedProcedure("durable:read")
    .input(instanceParam)
    .query(({ ctx, input }) => requireDurable(ctx).getLogs(input.instanceId)),

  resume: protectedProcedure("durable:resume")
    .input(instanceParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await requireDurable(ctx).resumeNow(input.instanceId)
      return ok
    }),

  retry: protectedProcedure("durable:retry")
    .input(instanceParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await requireDurable(ctx).retry(input.instanceId)
      return ok
    }),

  retryCompensation: protectedProcedure("durable:retry")
    .input(instanceParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await requireDurable(ctx).retryCompensation(input.instanceId)
      return ok
    }),

  cancel: protectedProcedure("durable:cancel")
    .input(instanceParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await requireDurable(ctx).cancel(input.instanceId)
      return ok
    }),

  delete: protectedProcedure("durable:delete")
    .input(instanceParam)
    .mutation(async ({ ctx, input }): Promise<ActionResult> => {
      await requireDurable(ctx).deleteState(input.instanceId)
      return ok
    }),
})
