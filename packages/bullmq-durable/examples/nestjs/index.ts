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

type GenerationJobs = {
  video: { data: CreateVideoInput; result: VideoResult }
}

const connection = { host: "127.0.0.1", port: 6379 }

@DurableProcessor("generation")
export class GenerationProcessor {
  @DurableProcess("video")
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
    @InjectDurableQueue("generation")
    private readonly queue: DurableQueue<GenerationJobs>,
  ) {}

  async createVideo(input: CreateVideoInput) {
    return this.queue.add("video", input, { jobId: input.generationId })
  }
}

@Module({
  imports: [
    DurableBullModule.forRoot({ connection }),
    DurableBullModule.registerQueue({
      name: "generation",
      retention: { completed: "7d", failed: "30d" },
    }),
  ],
  providers: [GenerationProcessor, GenerationService],
})
export class GenerationModule {}

// --- Fake helpers (replace with real ones) ----------------------------------

async function createTask(_input: CreateVideoInput): Promise<{ id: string }> {
  return { id: "provider-task-1" }
}

async function saveResult(_taskId: string): Promise<VideoResult> {
  return { assetId: "asset_1" }
}
