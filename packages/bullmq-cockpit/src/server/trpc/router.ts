/**
 * The root tRPC router — the single type the client consumes.
 *
 * `AppRouter` is the whole client↔server contract: every procedure's input
 * (validated by its zod schema) and output (inferred from the inspector it
 * calls). The browser imports **only this type** (`import type { AppRouter }`),
 * so the two builds share one source of truth and can never drift.
 */

import { router } from "./trpc"
import { alertsRouter } from "./routers/alerts"
import { configRouter } from "./routers/config"
import { durableRouter } from "./routers/durable"
import { flowsRouter } from "./routers/flows"
import { healthRouter } from "./routers/health"
import { jobsRouter } from "./routers/jobs"
import { overviewRouter } from "./routers/overview"
import { queuesRouter } from "./routers/queues"
import { schedulersRouter } from "./routers/schedulers"

export const appRouter = router({
  config: configRouter,
  overview: overviewRouter,
  queues: queuesRouter,
  jobs: jobsRouter,
  schedulers: schedulersRouter,
  flows: flowsRouter,
  alerts: alertsRouter,
  durable: durableRouter,
  health: healthRouter,
})

/** The full API contract. The client imports this **type** only. */
export type AppRouter = typeof appRouter
