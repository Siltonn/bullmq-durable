/**
 * Mount the tRPC router onto the Hono app via the fetch adapter.
 *
 * tRPC owns everything under `/api/trpc` (the path is always stripped of the
 * cockpit's mount base by the adapters, so the endpoint is constant here). It
 * runs its own auth + permission checks through the context, so — unlike the old
 * REST routes — it needs no surrounding Hono middleware.
 */

import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import type { Hono } from "hono"
import type { BoardContext } from "../context"
import { appRouter } from "./router"
import { createCockpitContext } from "./trpc"

export const TRPC_ENDPOINT = "/api/trpc"

export function registerTRPC(app: Hono<any>, board: BoardContext): void {
  app.all(`${TRPC_ENDPOINT}/*`, (c) =>
    fetchRequestHandler({
      endpoint: TRPC_ENDPOINT,
      req: c.req.raw,
      router: appRouter,
      createContext: () => createCockpitContext(board, c.req.raw),
      onError({ error, path }) {
        // HttpErrors are mapped to the right code upstream; only genuinely
        // unexpected failures reach here as INTERNAL_SERVER_ERROR.
        if (error.code === "INTERNAL_SERVER_ERROR") {
          console.error(`[bullmq-cockpit] tRPC ${path ?? "<unknown>"}:`, error.cause ?? error)
        }
      },
    }),
  )
}
