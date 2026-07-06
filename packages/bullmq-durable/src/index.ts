/**
 * bullmq-durable — durable execution for BullMQ jobs.
 *
 * Public entry point. The NestJS integration lives behind the
 * `bullmq-durable/nestjs` subpath and is intentionally NOT re-exported here, so
 * importing this module never pulls in `@nestjs/*`.
 */

export {
  DurableQueue,
  type DurableRunCounts,
  type DurableRunListKind,
  type DurableRunListQuery,
  type DurableRunPage,
  type DurableRunPageQuery,
  type DurableRunPageResult,
} from "./queue"
export { DurableRun, type DurableCarrier, type DurableCarrierState } from "./run"
export { DurableWorker, runOutcomeToReturn } from "./worker"
export {
  DurableContextImpl,
  type DurableContextDeps,
  type JobLogSink,
  type PendingResume,
  type RunMode,
} from "./execution/context"
export {
  DurableRuntime,
  type DurableRuntimeJob,
  type DurableRuntimeParams,
  type RunOutcome,
} from "./execution/runtime"
export { bullJobKeysExist, DurableReaper, type JobsExist } from "./reaper"
export {
  summarizeInstances,
  type DurableRunSummary,
  type SummarizeOptions,
} from "./inspect/summarize"
export {
  classifyLocalStuck,
  deriveView,
  sleepWakeAt,
  synthesizeEvents,
  type DurableDerivedStatus,
  type DurableDerivedView,
  type DurableRunEvent,
  type DurableStuckKind,
} from "./inspect/derive"

// LEGACY (0.1.x rolling-upgrade window only; removed in 0.3.0): envelope
// detection for in-flight resume jobs, exported so dashboards can label them.
export {
  DURABLE_META_KEY,
  isResumeEnvelope,
  unwrapResumeData,
  type DurableMeta,
  type ResumeEnvelope,
} from "./legacy/envelope"

export * from "./errors"
export * from "./types"
export * from "./store"

export { type DurationInput, isDurationLike, parseDuration } from "./utils/duration"
export {
  createInstanceId,
  DEFAULT_DURABLE_PREFIX,
  durableProbeKeys,
  stepIdOf,
} from "./utils/keys"
export {
  DURABLE_LOG_MARKER,
  DURABLE_LOG_VERSION,
  parseJobLogs,
  parseLogLine,
  serializeLogEntry,
} from "./utils/log"
