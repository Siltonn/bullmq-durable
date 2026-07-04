/**
 * bullmq-cockpit — modern dashboard and durable instance inspector for BullMQ.
 *
 * This entry is intentionally framework-agnostic: it exposes the Hono app
 * factory and the public option/DTO types, but imports no host framework. Mount
 * it with one of the adapters:
 *
 *   import { createBullMQCockpit } from "bullmq-cockpit/express"
 *   import { createBullMQCockpit } from "bullmq-cockpit/fastify"
 *   import { BullMQCockpitModule } from "bullmq-cockpit/nestjs"
 *   import { startCockpit } from "bullmq-cockpit/standalone"
 *
 * …or use the Hono app directly via {@link createCockpitApp}.
 */

import type { Hono } from "hono"
import type { CockpitVariables } from "./server/middleware/auth"
import { createCockpitApp } from "./server/app"
import type { BullMQCockpitOptions } from "./server/options"

export { createCockpitApp, type CockpitApp } from "./server/app"
export { createBoardContext, type BoardContext } from "./server/context"
export { COCKPIT_VERSION } from "./server/options"

/**
 * The tRPC contract. The browser client imports this **type** only
 * (`import type { AppRouter }`) to get end-to-end type safety with zero
 * hand-written wire types.
 */
export type { AppRouter } from "./server/trpc/router"
export type {
  AuthContext,
  AuthHandler,
  AuthResult,
  BullMQCockpitOptions,
  DurableCockpitOptions,
  NormalizedCockpitOptions,
} from "./server/options"

// Re-export every wire contract so consumers can type their own integrations.
export * from "./shared/dto"

/**
 * Build the cockpit as a raw Hono app. Prefer an adapter unless you are mounting
 * into a fetch-based runtime yourself; adapters also expose `context.close()`
 * for graceful shutdown.
 */
export function createBullMQCockpit(
  options: BullMQCockpitOptions,
): Hono<{ Variables: CockpitVariables }> {
  return createCockpitApp(options).app
}
