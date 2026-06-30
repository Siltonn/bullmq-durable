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
import type { DurableProcessorMetadata } from "./types"

/**
 * Mark a provider class as the durable processor for `queueName`. Its single
 * {@link DurableProcess} method runs every job on the queue.
 */
export function DurableProcessor(queueName: string): ClassDecorator {
  return SetMetadata(DURABLE_PROCESSOR_METADATA, {
    queueName,
  } satisfies DurableProcessorMetadata)
}

/**
 * Mark a method as the durable processor for its `@DurableProcessor` — it runs
 * every job on the queue, whatever the job name (read `job.name` inside to
 * branch). No argument: the class's `@DurableProcessor` already fixes the queue,
 * so there's nothing more to scope. One per processor — mirroring
 * `@nestjs/bullmq`'s single `process()` method.
 */
export function DurableProcess(): MethodDecorator {
  return SetMetadata(DURABLE_PROCESS_METADATA, true)
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
