/**
 * Video-generation example: a long-running, provider-polling workflow.
 *
 * This is the canonical use case — create a provider task, poll it until it is
 * ready (retrying later without burning a worker), then persist the asset and
 * notify the user. Each step is checkpointed, so a crash or restart resumes
 * from the last completed step instead of re-charging the provider.
 */

import { DurableQueue, DurableWorker } from "bullmq-durable"

interface CreateVideoInput {
  userId: string
  prompt: string
}
interface VideoAsset {
  assetId: string
  url: string
}

type GenerationJobs = {
  video: { data: CreateVideoInput; result: VideoAsset }
}

const connection = { host: "127.0.0.1", port: 6379 }

export const queue = new DurableQueue<GenerationJobs>("generation", { connection })

export const worker = new DurableWorker<GenerationJobs>(
  "generation",
  {
    video: async (job, ctx) => {
      const task = await ctx.step("create-provider-task", () => provider.createVideo(job.data))

      await ctx.sleep("initial-wait", "10s")

      const result = await ctx.step(
        "poll-provider-task",
        { retry: { attempts: 60, delay: "10s" } },
        async () => {
          const status = await provider.getTask(task.id)

          if (status.state === "pending") {
            // Not ready yet — yield and try again later (does not occupy a worker).
            throw ctx.retryLater("provider still pending")
          }
          if (status.state === "failed") {
            // Permanent failure — do not waste the remaining attempts.
            throw ctx.nonRetryable("provider reported failure")
          }
          return status
        },
      )

      const asset = await ctx.step("save-asset", () =>
        assetService.save({
          // `ctx.stepId` is handy as a DB idempotency key.
          idempotencyKey: ctx.stepId("save-asset"),
          userId: job.data.userId,
          url: result.url,
        }),
      )

      await ctx.step("notify-user", () => notify(job.data.userId, asset.assetId))

      return asset
    },
  },
  {
    connection,
    concurrency: 10,
    lockTimeout: "5m",
    retention: { completed: "7d", failed: "30d" },
  },
)

export async function createVideo(input: CreateVideoInput, generationId: string): Promise<void> {
  await queue.add("video", input, { jobId: generationId })
}

// --- Fake provider + services (replace with real ones) ----------------------

const provider = {
  async createVideo(_input: CreateVideoInput): Promise<{ id: string }> {
    return { id: "provider-task-1" }
  },
  async getTask(_id: string): Promise<{ state: "pending" | "completed" | "failed"; url: string }> {
    return { state: "completed", url: "https://cdn.example.com/v.mp4" }
  },
}

const assetService = {
  async save(input: { idempotencyKey: string; userId: string; url: string }): Promise<VideoAsset> {
    return { assetId: `asset_${input.userId}`, url: input.url }
  },
}

async function notify(userId: string, assetId: string): Promise<void> {
  console.log(`notifying ${userId} about asset ${assetId}`)
}
