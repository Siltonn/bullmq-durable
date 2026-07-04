/**
 * The framework-agnostic core: build a single Hono app that serves the tRPC API
 * and the SPA. Every adapter wraps this — they differ only in how they hand HTTP
 * requests to `app.fetch` and where they mount it.
 *
 * The API is tRPC (mounted under `/api/trpc`), so the client and server share one
 * fully-typed contract (`AppRouter`) and no wire types are hand-written twice.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import { authMiddleware, type CockpitVariables } from "./middleware/auth"
import { buildCockpitConfig } from "./config"
import { registerClient } from "./client"
import { createBoardContext, type BoardContext } from "./context"
import {
  normalizeOptions,
  type BullMQCockpitOptions,
  type NormalizedCockpitOptions,
} from "./options"
import { registerTRPC } from "./trpc/handler"

export interface CockpitApp {
  /** The Hono app — mount its `.fetch` handler, or use an adapter. */
  app: Hono<{ Variables: CockpitVariables }>
  /** The board context; call `context.close()` to release connections. */
  context: BoardContext
  options: NormalizedCockpitOptions
}

export function createCockpitApp(rawOptions: BullMQCockpitOptions): CockpitApp {
  const options = normalizeOptions(rawOptions)
  const context = createBoardContext(options)
  const auth = authMiddleware(context)

  const app = new Hono<{ Variables: CockpitVariables }>()

  app.onError((err, c) => {
    console.error("[bullmq-cockpit] unhandled error:", err)
    const message = err instanceof Error ? err.message : "Internal server error"
    return c.json({ error: "internal_error", message }, 500)
  })

  // --- tRPC API (owns its auth + permissions via the context) ---
  registerTRPC(app, context)

  // --- SPA + static assets (assets public, shell auth-gated) ---
  // The shell reads permissions/principal from the auth middleware's context.
  const buildConfig = (c: Context) =>
    buildCockpitConfig(context, c.get("permissions") ?? [], c.get("user"))
  registerClient(app, options.clientDir, buildConfig, auth)

  return { app, context, options }
}
