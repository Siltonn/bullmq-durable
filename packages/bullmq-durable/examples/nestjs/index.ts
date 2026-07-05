/**
 * NestJS example.
 *
 * Mirrors the `@nestjs/bullmq` developer experience without depending on it:
 * `@DurableProcessor` / `@DurableProcess` declare the worker, and
 * `@InjectDurableQueue` injects a typed queue into a service.
 */

import { Injectable, Module } from "@nestjs/common"
import {
  type DurableContext,
  type DurableJob,
  DurableBullModule,
  DurableProcess,
  DurableProcessor,
  DurableQueue,
  InjectDurableQueue,
} from "bullmq-durable/nestjs"

interface CreateVideoInput {
  userId: string
  prompt: string
  generationId: string
}
interface VideoResult {
  assetId: string
}

const connection = { host: "127.0.0.1", port: 6379 }

@DurableProcessor("generation")
export class GenerationProcessor {
  // One handler for the whole queue — the class's @DurableProcessor already fixes
  // the queue, so no job name is needed. Branch on `job.name` if the queue
  // carries several; the handler types its own payload.
  @DurableProcess()
  async run(
    job: DurableJob<CreateVideoInput, VideoResult>,
    ctx: DurableContext,
  ): Promise<VideoResult> {
    const task = await ctx.step("create-task", () => createTask(job.data))
    await ctx.sleep("wait-first-poll", "10s")
    return ctx.step("save-result", () => saveResult(task.id))
  }
}

@Injectable()
export class GenerationService {
  constructor(
    // The queue is payload-typed, exactly like a BullMQ `Queue<Data, Result>`.
    @InjectDurableQueue("generation")
    private readonly queue: DurableQueue<CreateVideoInput, VideoResult>,
  ) {}

  async createVideo(input: CreateVideoInput) {
    return this.queue.add("video", input, { jobId: input.generationId })
  }
}

@Module({
  imports: [
    // `forRootAsync` is also available to source `connection` from a ConfigService.
    DurableBullModule.forRoot({ connection }),
    DurableBullModule.registerQueue({
      name: "generation",
      // One run = one job: BullMQ's own cleanup options govern the run record.
      defaultJobOptions: {
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
        keepLogs: 1000,
      },
      // Listing the processor here auto-registers it — no separate `providers` entry.
      processor: GenerationProcessor,
    }),
  ],
  providers: [GenerationService],
})
export class GenerationModule {}

// --- Fake helpers (replace with real ones) ----------------------------------

async function createTask(_input: CreateVideoInput): Promise<{ id: string }> {
  return { id: "provider-task-1" }
}

async function saveResult(_taskId: string): Promise<VideoResult> {
  return { assetId: "asset_1" }
}
