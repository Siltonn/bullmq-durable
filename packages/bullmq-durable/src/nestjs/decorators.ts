/**
 * Class/method decorators that mirror `@nestjs/bullmq`'s ergonomics without
 * depending on it. They simply attach metadata that {@link DurableExplorer}
 * reads at startup.
 */

import { SetMetadata } from "@nestjs/common"
import {
  DURABLE_FAILURE_METADATA,
  DURABLE_PROCESS_METADATA,
  DURABLE_PROCESSOR_METADATA,
} from "./tokens"
import type { DurableProcessMetadata, DurableProcessorMetadata } from "./types"

/**
 * Mark a provider class as the durable processor for `queueName`. Methods
 * inside it are wired to job names via {@link DurableProcess}.
 */
export function DurableProcessor(queueName: string): ClassDecorator {
  return SetMetadata(DURABLE_PROCESSOR_METADATA, {
    queueName,
  } satisfies DurableProcessorMetadata)
}

/** Mark a method as the handler for `jobName` within a `@DurableProcessor`. */
export function DurableProcess(jobName: string): MethodDecorator {
  return SetMetadata(DURABLE_PROCESS_METADATA, { jobName } satisfies DurableProcessMetadata)
}

/**
 * Mark a method as the terminal-failure handler for its `@DurableProcessor`. One
 * handler settles every job on the processor — mirroring `@OnWorkerEvent('failed')`,
 * read `job.name` inside if you need to branch. It runs (after per-step
 * compensation) only for genuine failures — control-flow signals never reach it —
 * and receives `(job, ctx, failure)`.
 */
export function DurableFailure(): MethodDecorator {
  return SetMetadata(DURABLE_FAILURE_METADATA, true)
}
