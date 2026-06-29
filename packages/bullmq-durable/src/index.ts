/**
 * bullmq-durable — durable execution for BullMQ jobs.
 *
 * Public entry point. The NestJS integration lives behind the
 * `bullmq-durable/nestjs` subpath and is intentionally NOT re-exported here, so
 * importing this module never pulls in `@nestjs/*`.
 */

export { DurableQueue } from "./queue"
export { DurableWorker } from "./worker"
export { DurableContextImpl, type DurableContextDeps, type JobLogSink } from "./context"
export { DurableRuntime, type DurableRuntimeParams, type RunOutcome } from "./runtime"
export type { ResumeScheduler, ScheduleResumeInput } from "./scheduler"

export * from "./errors"
export * from "./types"
export * from "./store"

export {
  DURABLE_META_KEY,
  type DurableMeta,
  type ResumeEnvelope,
  isResumeEnvelope,
  unwrapResumeData,
  wrapResumeData,
} from "./envelope"

export { type DurationInput, isDurationLike, parseDuration } from "./utils/duration"
export { createInstanceId, DEFAULT_DURABLE_PREFIX, stepIdOf } from "./utils/keys"
