/**
 * The framework-agnostic core: build a single Hono app that serves the JSON API
 * and the SPA. Every adapter wraps this — they differ only in how they hand HTTP
 * requests to `app.fetch` and where they mount it.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import type { CockpitConfig } from "../shared/dto"
import { authMiddleware, effectivePermissions, type CockpitVariables } from "./middleware/auth"
import { registerClient } from "./client"
import { createBoardContext, type BoardContext } from "./context"
import { HttpError } from "./http/http-error"
import {
  normalizeOptions,
  type BullMQCockpitOptions,
  type NormalizedCockpitOptions,
} from "./options"
import { alertRoutes } from "./routes/alerts"
import { durableRoutes } from "./routes/durable"
import { flowRoutes } from "./routes/flows"
import { healthRoutes } from "./routes/health"
import { jobRoutes } from "./routes/jobs"
import { overviewRoutes } from "./routes/overview"
import { queueRoutes } from "./routes/queues"
import { schedulerRoutes } from "./routes/schedulers"

export interface CockpitApp {
  /** The Hono app — mount its `.fetch` handler, or use an adapter. */
  app: Hono<{ Variables: CockpitVariables }>
  /** The board context; call `context.close()` to release connections. */
  context: BoardContext
  options: NormalizedCockpitOptions
}

/** Build the per-request {@link CockpitConfig} from the resolved auth state. */
function buildConfig(context: BoardContext, c: Context): CockpitConfig {
  const permissions = (c.get("permissions") as CockpitVariables["permissions"]) ?? []
  return {
    basePath: context.options.basePath,
    durableEnabled: context.options.durable.enabled,
    readonly: context.options.readonly,
    permissions: effectivePermissions(context, permissions),
    user: c.get("user"),
    version: context.options.version,
  }
}

export function createCockpitApp(rawOptions: BullMQCockpitOptions): CockpitApp {
  const options = normalizeOptions(rawOptions)
  const context = createBoardContext(options)
  const auth = authMiddleware(context)

  const app = new Hono<{ Variables: CockpitVariables }>()

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message }, err.status as never)
    }
    console.error("[bullmq-cockpit] unhandled error:", err)
    const message = err instanceof Error ? err.message : "Internal server error"
    return c.json({ error: "internal_error", message }, 500)
  })

  // --- JSON API (authenticated) ---
  app.use("/api/*", auth)
  app.get("/api/config", (c) => c.json(buildConfig(context, c)))
  app.route("/api/overview", overviewRoutes(context))
  app.route("/api/queues", queueRoutes(context))
  app.route("/api/queues", jobRoutes(context))
  app.route("/api/schedulers", schedulerRoutes(context))
  app.route("/api/flows", flowRoutes(context))
  app.route("/api/alerts", alertRoutes(context))
  app.route("/api/durable", durableRoutes(context))
  app.route("/api/health", healthRoutes(context))
  app.all("/api/*", (c) => c.json({ error: "not_found", message: "Unknown API route" }, 404))

  // --- SPA + static assets (assets public, shell auth-gated) ---
  registerClient(app, options.clientDir, (c) => buildConfig(context, c), auth)

  return { app, context, options }
}
