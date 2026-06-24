/**
 * `bullmq-durable/nestjs` — the optional NestJS integration.
 *
 * Importing this subpath requires `@nestjs/common` and `@nestjs/core`, which are
 * declared as optional peer dependencies. The core package never imports it.
 */

export { DurableBullModule } from "./module"
export { DurableProcess, DurableProcessor } from "./decorators"
export { getDurableQueueToken, InjectDurableQueue } from "./injector"
export { DurableExplorer } from "./explorer"
export {
  DURABLE_BULL_OPTIONS,
  DURABLE_PROCESS_METADATA,
  DURABLE_PROCESSOR_METADATA,
  DURABLE_WORKER_FACTORY,
  getDurableQueueOptionsToken,
} from "./tokens"
export type {
  DurableBullRootOptions,
  DurableProcessMetadata,
  DurableProcessorMetadata,
  DurableQueueRegistration,
  DurableWorkerFactory,
  DurableWorkerHandle,
} from "./types"

// Re-export the core symbols most NestJS apps need in processor signatures.
export { DurableQueue } from "../queue"
export type { DurableContext, DurableJob, DurableJobMap } from "../types"
