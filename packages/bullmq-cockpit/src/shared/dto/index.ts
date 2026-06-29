/**
 * Wire contracts shared by the server and the React client.
 *
 * The single source of truth for every shape that crosses the HTTP boundary,
 * **split per domain** under this folder. It is intentionally near-pure types so
 * the client can consume it (via the `@shared/dto` alias) without pulling any
 * server/node dependencies into the browser bundle.
 *
 * This barrel re-exports every domain so `@shared/dto` stays a single import.
 * Zod request/param schemas live separately in `src/server/contracts.ts`.
 */

export * from "./common"
export * from "./auth"
export * from "./jobs"
export * from "./queues"
export * from "./durable"
export * from "./health"
export * from "./schedulers"
export * from "./metrics"
export * from "./signals"
export * from "./flows"
export * from "./alerts"
