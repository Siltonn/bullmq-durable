/**
 * Option shapes for the NestJS integration.
 */

import type { ModuleMetadata, Type } from "@nestjs/common"
import type { ConnectionOptions, JobsOptions } from "bullmq"
import type { StateStore } from "../store/state-store"
import type {
  DurableProcessorInput,
  DurableWorkerOptions,
  RetentionOptions,
  RetryOptions,
  StepOptions,
} from "../types"
import type { DurationInput } from "../utils/duration"

/** A factory dependency token — mirrors NestJS' own `inject` array entries. */
export type DurableInjectionToken =
  | string
  | symbol
  | Type<unknown>
  | (new (...args: any[]) => unknown)

/** Root options passed to `DurableBullModule.forRoot`. */
export interface DurableBullRootOptions {
  connection: ConnectionOptions
  /** Register the module globally (default `true`). */
  global?: boolean
  /**
   * A custom store shared by every queue and worker. When omitted, the module
   * creates a single {@link import("../store/redis-store").RedisStateStore} from
   * `connection` and shares that — so all queues/workers use one connection.
   */
  stateStore?: StateStore
  durablePrefix?: string
  bullPrefix?: string
  // Defaults applied to every worker unless overridden per queue.
  concurrency?: number
  lockTimeout?: DurationInput
  retention?: RetentionOptions
  defaultStepOptions?: StepOptions
  defaultRollbackRetry?: RetryOptions
  maxLogs?: number
}

/**
 * Async form of {@link DurableBullRootOptions}, for sourcing `connection` (and
 * everything else) from DI — e.g. a `ConfigService`. Mirrors the `forRootAsync`
 * shape used across the NestJS ecosystem.
 */
export interface DurableBullRootAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  /** Register the module globally (default `true`). */
  global?: boolean
  /** Providers injected into `useFactory`. */
  inject?: DurableInjectionToken[]
  /** Builds the root options, possibly asynchronously. */
  useFactory: (...args: any[]) => DurableBullRootOptions | Promise<DurableBullRootOptions>
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
  defaultRollbackRetry?: RetryOptions
  maxLogs?: number
  defaultJobOptions?: JobsOptions
  /**
   * Processor class(es) for this queue. Listing them here auto-registers them as
   * providers (and exports them) so the explorer discovers them — you no longer
   * have to remember to add the `@DurableProcessor` class to the module's own
   * `providers`.
   */
  processor?: Type<unknown> | Type<unknown>[]
}

/** Async form of {@link DurableQueueRegistration}: resolve per-queue options from DI. */
export interface DurableQueueAsyncRegistration extends Pick<ModuleMetadata, "imports"> {
  name: string
  /** Providers injected into `useFactory`. */
  inject?: DurableInjectionToken[]
  /** Builds the per-queue options (minus `name`), possibly asynchronously. */
  useFactory: (
    ...args: any[]
  ) => Omit<DurableQueueRegistration, "name"> | Promise<Omit<DurableQueueRegistration, "name">>
  /** Processor class(es) to auto-register for this queue. See {@link DurableQueueRegistration.processor}. */
  processor?: Type<unknown> | Type<unknown>[]
}

/** A disposable worker handle; the real {@link DurableWorker} satisfies this. */
export interface DurableWorkerHandle {
  close(): Promise<void>
}

/** Factory used by the explorer to build workers (swappable in tests). */
export type DurableWorkerFactory = (
  queueName: string,
  processor: DurableProcessorInput,
  options: DurableWorkerOptions,
) => DurableWorkerHandle

/** Metadata attached by `@DurableProcessor()`. */
export interface DurableProcessorMetadata {
  queueName: string
}
