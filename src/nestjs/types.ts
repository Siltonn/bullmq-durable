/**
 * Option shapes for the NestJS integration.
 */

import type { ConnectionOptions, JobsOptions } from "bullmq"
import type {
  DurableJobMap,
  DurableProcessorInput,
  DurableWorkerOptions,
  RetentionOptions,
  StepOptions,
} from "../types"
import type { DurationInput } from "../utils/duration"

/** Root options passed to `DurableBullModule.forRoot`. */
export interface DurableBullRootOptions {
  connection: ConnectionOptions
  /** Register the module globally (default `true`). */
  global?: boolean
  durablePrefix?: string
  bullPrefix?: string
  // Defaults applied to every worker unless overridden per queue.
  concurrency?: number
  lockTimeout?: DurationInput
  retention?: RetentionOptions
  defaultStepOptions?: StepOptions
  maxLogs?: number
}

/** Per-queue options passed to `DurableBullModule.registerQueue`. */
export interface DurableQueueRegistration {
  name: string
  durablePrefix?: string
  bullPrefix?: string
  concurrency?: number
  lockTimeout?: DurationInput
  retention?: RetentionOptions
  defaultStepOptions?: StepOptions
  maxLogs?: number
  defaultJobOptions?: JobsOptions
}

/** A disposable worker handle; the real {@link DurableWorker} satisfies this. */
export interface DurableWorkerHandle {
  close(): Promise<void>
}

/** Factory used by the explorer to build workers (swappable in tests). */
export type DurableWorkerFactory = (
  queueName: string,
  processor: DurableProcessorInput<DurableJobMap>,
  options: DurableWorkerOptions,
) => DurableWorkerHandle

/** Metadata attached by `@DurableProcessor()`. */
export interface DurableProcessorMetadata {
  queueName: string
}

/** Metadata attached by `@DurableProcess()`. */
export interface DurableProcessMetadata {
  jobName: string
}
