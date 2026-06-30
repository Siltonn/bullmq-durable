/**
 * Seed a local Redis with rich, realistic data so the dashboard shows every
 * state out of the box:
 *
 *  Plain BullMQ queues
 *    - emails / payments            completed + failed (with stacktrace)
 *    - notifications / exports-csv  waiting + delayed
 *    - checkout                     per-job logs, a large nested payload, rich
 *                                   return values, a 3-retry stacktrace failure,
 *                                   a 55-job bulk (pagination), prioritized /
 *                                   waiting / delayed jobs
 *
 *  Flows (FlowProducer DAGs)
 *    - orders      a 3-level tree left all-waiting (no worker)
 *    - media-flow  processed by a worker that OOM-kills one rendition → a mix of
 *                  completed / failed / waiting-children
 *
 *  Durable queues
 *    - generation  completed, sleeping, retrying, failed, cancelled, plus a
 *                  direct-written "running_stale" + an "orphan_resume_job"
 *    - exports     a second durable queue (completed + sleeping) for filter variety
 *    - media       a 6-step pipeline: completed×2, sleeping, failed (deep in
 *                  `transcode`), a high-attempt "retrying", and a "resume_missed"
 *
 * Between them the four stuck kinds (running_stale, resume_missed,
 * orphan_resume_job, orphan_instance) all light up on the Health page.
 *
 * Usage:
 *   docker compose -f packages/bullmq-cockpit/docker-compose.yml up -d
 *   pnpm --filter bullmq-cockpit seed            # idempotent (fixed job ids)
 *   pnpm --filter bullmq-cockpit seed --reset    # FLUSHDB first, then seed
 *
 * Honors REDIS_URL (default redis://127.0.0.1:6379).
 */

import { FlowProducer, Queue, Worker } from "bullmq"
import { DurableQueue, DurableWorker, type DurableJob } from "bullmq-durable"
import { Redis } from "ioredis"

const url = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379")
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  password: url.password || undefined,
  db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
}
const DURABLE_PREFIX = "bullmq-durable"
const RESET = process.argv.includes("--reset") || process.env.RESET === "1"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Plain BullMQ queues
// ---------------------------------------------------------------------------

/** A queue whose jobs are processed immediately → completed / failed. */
async function seedProcessedQueue(
  name: string,
  jobs: Array<{ jobId: string; jobName: string; data: Record<string, unknown>; fail?: boolean }>,
): Promise<void> {
  const queue = new Queue(name, { connection })
  const worker = new Worker(
    name,
    async (job) => {
      await sleep(40)
      if (job.data?.__fail) {
        throw new Error(job.data.__failReason ?? "Downstream service returned 500")
      }
      return { ok: true, processedAt: new Date().toISOString() }
    },
    { connection, concurrency: 8 },
  )

  for (const job of jobs) {
    await queue.add(
      job.jobName,
      job.fail ? { ...job.data, __fail: true, __failReason: job.data.__failReason } : job.data,
      { jobId: job.jobId, attempts: 1, removeOnComplete: false, removeOnFail: false },
    )
  }

  await sleep(700)
  await worker.close()
  await queue.close()
}

/** A queue with no worker → jobs sit in waiting / delayed for the dashboard. */
async function seedPendingQueue(
  name: string,
  jobs: Array<{ jobId: string; jobName: string; data: Record<string, unknown>; delayMs?: number }>,
): Promise<void> {
  const queue = new Queue(name, { connection })
  for (const job of jobs) {
    await queue.add(job.jobName, job.data, { jobId: job.jobId, delay: job.delayMs })
  }
  await queue.close()
}

// ---------------------------------------------------------------------------
// Durable queues
// ---------------------------------------------------------------------------

interface VideoJob {
  id: string
  mode: "complete" | "sleep" | "retry" | "fail"
  userId: string
  prompt: string
}

async function seedGeneration(redis: Redis): Promise<void> {
  const queue = new DurableQueue<VideoJob>("generation", { connection })
  const worker = new DurableWorker(
    "generation",
    async (job: DurableJob<VideoJob>, ctx) => {
      await ctx.log(`Starting generation for ${job.data.id}`, { mode: job.data.mode })
      const task = await ctx.step("create-provider-task", async () => ({
        taskId: `task_${job.data.id}`,
        provider: "render-farm",
        queuedAt: new Date().toISOString(),
      }))

      if (job.data.mode === "fail") {
        await ctx.step("reserve-capacity", async () => {
          throw new Error("Provider rejected the request: render quota exceeded")
        })
      }
      if (job.data.mode === "sleep") {
        await ctx.sleep("wait-for-render", "12m")
      }
      if (job.data.mode === "retry") {
        await ctx.step(
          "poll-provider",
          { retry: { attempts: 50, backoff: "fixed", delay: "5m" } },
          async () => {
            throw ctx.retryLater("provider still rendering")
          },
        )
      }

      const asset = await ctx.step("save-asset", async () => ({
        url: `https://cdn.example.com/${job.data.id}.mp4`,
        bytes: 1024 * 1024 * 12,
        codec: "h264",
      }))
      await ctx.log("Generation complete")
      return { taskId: task.taskId, ...asset }
    },
    { connection, concurrency: 6 },
  )

  const mk = (id: string, mode: VideoJob["mode"]): VideoJob => ({
    id,
    mode,
    userId: `user_${id.slice(-1)}`,
    prompt: "A neon city at dusk, cinematic, 4k",
  })

  const jobs: VideoJob[] = [
    mk("vid-complete-1", "complete"),
    mk("vid-complete-2", "complete"),
    mk("vid-complete-3", "complete"),
    mk("vid-complete-4", "complete"),
    mk("vid-sleeping-1", "sleep"),
    mk("vid-sleeping-2", "sleep"),
    mk("vid-retrying-1", "retry"),
    mk("vid-failed-1", "fail"),
    mk("vid-cancel-1", "sleep"), // sleeps, then we cancel it below
  ]
  for (const job of jobs) await queue.add("video", job, { jobId: job.id })

  // Let the quick jobs complete and the long ones yield into sleeping/retrying.
  await sleep(4500)

  // Cancel the one we parked in `sleeping`.
  await queue.cancel("vid-cancel-1")

  // An orphan resume job: a resume tick whose instance does not exist.
  await queue.scheduleResume({
    instanceId: "generation:vid-ghost-1",
    queueName: "generation",
    jobName: "video",
    jobData: mk("vid-ghost-1", "complete"),
    originalJobId: "vid-ghost-1",
    resumeSeq: 1,
    delayMs: 6 * 60 * 1000,
    reason: "sleep:wait-for-render",
  })

  // A "running_stale" stuck instance: status=running with an old updatedAt.
  // Written directly through the documented durable layout.
  await writeStuckRunning(redis, {
    instanceId: "generation:vid-stuck-1",
    queueName: "generation",
    jobName: "video",
    originalJobId: "vid-stuck-1",
    input: mk("vid-stuck-1", "complete"),
    stepKey: "render-frames",
    ageMs: 32 * 60 * 1000,
  })

  await worker.close()
  await queue.close()
}

interface ExportJob {
  id: string
  mode: "complete" | "sleep"
}

async function seedExports(): Promise<void> {
  const queue = new DurableQueue<ExportJob>("exports", { connection })
  const worker = new DurableWorker(
    "exports",
    async (job: DurableJob<ExportJob>, ctx) => {
      await ctx.step("gather-rows", async () => ({ rows: 48213 }))
      if (job.data.mode === "sleep") await ctx.sleep("await-upload", "8m")
      return ctx.step("upload", async () => ({
        url: `https://cdn.example.com/exports/${job.data.id}.csv`,
      }))
    },
    { connection, concurrency: 4 },
  )

  await queue.add("report", { id: "exp-complete-1", mode: "complete" }, { jobId: "exp-complete-1" })
  await queue.add("report", { id: "exp-complete-2", mode: "complete" }, { jobId: "exp-complete-2" })
  await queue.add("report", { id: "exp-sleeping-1", mode: "sleep" }, { jobId: "exp-sleeping-1" })

  await sleep(2500)
  await worker.close()
  await queue.close()
}

/**
 * Write a `running` instance with an old `updatedAt` straight to Redis, so the
 * health inspector flags it as `running_stale`. Mirrors the runtime's hash
 * encoding (see bullmq-durable/src/store/redis-store.ts).
 */
async function writeStuckRunning(
  redis: Redis,
  opts: {
    instanceId: string
    queueName: string
    jobName: string
    originalJobId: string
    input: unknown
    stepKey: string
    ageMs: number
  },
): Promise<void> {
  const old = Date.now() - opts.ageMs
  await redis.hset(`${DURABLE_PREFIX}:instance:${opts.instanceId}`, {
    id: opts.instanceId,
    queueName: opts.queueName,
    jobName: opts.jobName,
    originalJobId: opts.originalJobId,
    status: "running",
    input: JSON.stringify(opts.input),
    runCount: "1",
    resumeSeq: "0",
    createdAt: String(old),
    updatedAt: String(old),
  })
  await redis.hset(
    `${DURABLE_PREFIX}:steps:${opts.instanceId}`,
    opts.stepKey,
    JSON.stringify({
      key: opts.stepKey,
      type: "step",
      status: "running",
      attempts: 2,
      startedAt: old,
    }),
  )
}

/**
 * Direct-write a `yielded` instance parked on a high-attempt `running` step with
 * a `nextRunAt` — the runtime's encoding of "retrying". A future `nextRunAt`
 * derives to `retrying`; a past one (older than the stuck threshold) additionally
 * trips `resume_missed`. Carries a few completed steps + logs so the detail view
 * is rich.
 */
async function writeRetrying(
  redis: Redis,
  opts: {
    instanceId: string
    queueName: string
    jobName: string
    originalJobId: string
    input: unknown
    completed: Array<{ key: string; result: unknown }>
    current: { key: string; attempts: number; nextRunInMs: number }
    logs: string[]
  },
): Promise<void> {
  const now = Date.now()
  const createdAt = now - 14 * 60 * 1000
  await redis.hset(`${DURABLE_PREFIX}:instance:${opts.instanceId}`, {
    id: opts.instanceId,
    queueName: opts.queueName,
    jobName: opts.jobName,
    originalJobId: opts.originalJobId,
    status: "yielded",
    input: JSON.stringify(opts.input),
    runCount: String(opts.current.attempts + 1),
    resumeSeq: String(opts.current.attempts),
    createdAt: String(createdAt),
    updatedAt: String(now),
  })
  const stepsHash: Record<string, string> = {}
  let t = createdAt
  for (const s of opts.completed) {
    const start = t
    const end = t + 350
    t = end + 40
    stepsHash[s.key] = JSON.stringify({
      key: s.key,
      type: "step",
      status: "completed",
      attempts: 1,
      startedAt: start,
      completedAt: end,
      result: s.result,
    })
  }
  stepsHash[opts.current.key] = JSON.stringify({
    key: opts.current.key,
    type: "step",
    status: "running",
    attempts: opts.current.attempts,
    startedAt: t,
    nextRunAt: now + opts.current.nextRunInMs,
  })
  await redis.del(
    `${DURABLE_PREFIX}:steps:${opts.instanceId}`,
    `${DURABLE_PREFIX}:logs:${opts.instanceId}`,
  )
  await redis.hset(`${DURABLE_PREFIX}:steps:${opts.instanceId}`, stepsHash)
  const logEntries = opts.logs.map((message, i) =>
    JSON.stringify({ message, timestamp: createdAt + i * 1500 }),
  )
  if (logEntries.length) {
    await redis.rpush(`${DURABLE_PREFIX}:logs:${opts.instanceId}`, ...logEntries)
  }
}

/**
 * Direct-write a fully *completed* multi-step run with realistic per-step timing
 * and step-scoped logs. The runtime prunes step state once an instance finishes,
 * so a live completed run keeps nothing to chart — we synthesise one here to
 * exercise the execution waterfall's proportional-bars + nested-logs case. Log
 * timestamps are placed inside their step's window so they nest under it (the
 * durable protocol doesn't tag logs with a step key).
 */
async function writeCompletedRun(
  redis: Redis,
  opts: {
    instanceId: string
    queueName: string
    jobName: string
    originalJobId: string
    input: unknown
    output: unknown
    steps: Array<{
      key: string
      durationMs: number
      result: unknown
      logs?: Array<{ message: string; atMs: number }>
    }>
    gapMs?: number
  },
): Promise<void> {
  const gap = opts.gapMs ?? 60
  const total = opts.steps.reduce((sum, s) => sum + s.durationMs + gap, 0) + 500
  const createdAt = Date.now() - total
  let t = createdAt + 250
  const stepsHash: Record<string, string> = {}
  const logs: Array<{ message: string; timestamp: number }> = [
    { message: `Run started for ${opts.originalJobId}`, timestamp: createdAt },
  ]
  for (const s of opts.steps) {
    const start = t
    const end = start + s.durationMs
    stepsHash[s.key] = JSON.stringify({
      key: s.key,
      type: "step",
      status: "completed",
      attempts: 1,
      startedAt: start,
      completedAt: end,
      result: s.result,
    })
    for (const log of s.logs ?? []) {
      logs.push({ message: log.message, timestamp: start + Math.min(log.atMs, s.durationMs - 1) })
    }
    t = end + gap
  }
  const completedAt = t
  await redis.del(
    `${DURABLE_PREFIX}:instance:${opts.instanceId}`,
    `${DURABLE_PREFIX}:steps:${opts.instanceId}`,
    `${DURABLE_PREFIX}:logs:${opts.instanceId}`,
  )
  await redis.hset(`${DURABLE_PREFIX}:instance:${opts.instanceId}`, {
    id: opts.instanceId,
    queueName: opts.queueName,
    jobName: opts.jobName,
    originalJobId: opts.originalJobId,
    status: "completed",
    input: JSON.stringify(opts.input),
    output: JSON.stringify(opts.output),
    runCount: "1",
    resumeSeq: "0",
    createdAt: String(createdAt),
    updatedAt: String(completedAt),
    completedAt: String(completedAt),
  })
  await redis.hset(`${DURABLE_PREFIX}:steps:${opts.instanceId}`, stepsHash)
  const logEntries = logs.sort((a, b) => a.timestamp - b.timestamp).map((l) => JSON.stringify(l))
  await redis.rpush(`${DURABLE_PREFIX}:logs:${opts.instanceId}`, ...logEntries)
}

// ---------------------------------------------------------------------------
// Complex fixtures (rich data for development & debugging)
// ---------------------------------------------------------------------------

/**
 * A high-fidelity plain queue: per-job logs, a large nested payload, rich return
 * values, a job that fails after 3 backed-off retries (real stacktrace), a 55-job
 * bulk for pagination, and prioritized / waiting / delayed jobs left pending.
 */
async function seedCheckout(): Promise<void> {
  const name = "checkout"
  const queue = new Queue(name, { connection })
  const worker = new Worker(
    name,
    async (job) => {
      await job.log(`Validating cart ${job.data.cartId} · ${job.data.items?.length ?? 0} item(s)`)
      await sleep(15)
      if (job.data.__fail) {
        await job.log(`Charge declined: ${job.data.__failReason}`)
        throw new Error(job.data.__failReason ?? "Payment gateway timeout")
      }
      await job.log("Inventory reserved")
      await job.log("Card charged via stripe")
      await job.log(`Order ord_${job.data.cartId} confirmed`)
      return {
        orderId: `ord_${job.data.cartId}`,
        chargedCents: job.data.totalCents ?? 0,
        items: job.data.items?.length ?? 0,
        confirmationSentAt: new Date().toISOString(),
        gateway: { provider: "stripe", latencyMs: 142, last4: "4242" },
      }
    },
    { connection, concurrency: 6 },
  )

  const bigCart = {
    cartId: "deluxe",
    customer: {
      id: "user_42",
      email: "max@example.com",
      address: {
        line1: "1 Infinite Loop",
        city: "Cupertino",
        region: "CA",
        postal: "95014",
        country: "US",
      },
      segments: ["vip", "early-access"],
    },
    items: Array.from({ length: 16 }, (_, i) => ({
      sku: `SKU-${1000 + i}`,
      name: `Product ${i + 1}`,
      qty: (i % 3) + 1,
      priceCents: 1999 + i * 250,
    })),
    totalCents: 84210,
    coupon: { code: "SUMMER25", percentOff: 25 },
    metadata: {
      source: "ios",
      appVersion: "4.12.0",
      experiments: { checkoutV2: true, oneClick: false },
    },
  }

  await queue.add("place-order", bigCart, { jobId: "checkout-ok-deluxe", removeOnComplete: false })
  for (let i = 1; i <= 3; i++) {
    await queue.add(
      "place-order",
      {
        cartId: `c${i}`,
        items: [{ sku: "SKU-1", name: "Widget", qty: i, priceCents: 2999 }],
        totalCents: 2999 * i,
      },
      { jobId: `checkout-ok-${i}`, removeOnComplete: false },
    )
  }
  await queue.add(
    "place-order",
    {
      cartId: "decline",
      totalCents: 5000,
      __fail: true,
      __failReason: "Card declined: insufficient_funds (code 51)",
    },
    {
      jobId: "checkout-fail-retry",
      attempts: 3,
      backoff: { type: "fixed", delay: 80 },
      removeOnFail: false,
    },
  )
  await queue.addBulk(
    Array.from({ length: 55 }, (_, i) => ({
      name: "place-order",
      data: {
        cartId: `bulk-${i}`,
        items: [{ sku: "SKU-9", name: "Sticker", qty: 1, priceCents: 500 }],
        totalCents: 500 + i * 13,
      },
      opts: { jobId: `checkout-bulk-${i}`, removeOnComplete: false },
    })),
  )

  await sleep(2600)
  await worker.close()

  // Left pending (no worker now): prioritized + waiting + delayed.
  await queue.add(
    "place-order",
    { cartId: "rush", totalCents: 19900 },
    { jobId: "checkout-prio-1", priority: 1 },
  )
  await queue.add(
    "place-order",
    { cartId: "vip", totalCents: 42000 },
    { jobId: "checkout-prio-2", priority: 2 },
  )
  await queue.add(
    "place-order",
    { cartId: "later", totalCents: 3000 },
    { jobId: "checkout-wait-1" },
  )
  await queue.add(
    "place-order",
    { cartId: "scheduled", totalCents: 7000 },
    { jobId: "checkout-delay-1", delay: 2 * 60 * 60 * 1000 },
  )

  await queue.close()
}

interface MediaJob {
  id: string
  mode: "complete" | "fail" | "sleep"
}

/**
 * A long durable pipeline (6 steps) with rich step results + logs. Produces a
 * fully-completed instance, one that fails deep in `transcode` (real error), and
 * one parked `sleeping` mid-pipeline — then direct-writes a high-attempt
 * `retrying` instance and a `resume_missed` one.
 */
async function seedMediaPipeline(redis: Redis): Promise<void> {
  const queue = new DurableQueue<MediaJob>("media", { connection })
  const worker = new DurableWorker(
    "media",
    async (job: DurableJob<MediaJob>, ctx) => {
      await ctx.log(`Encode request for ${job.data.id}`, { mode: job.data.mode })
      const probe = await ctx.step("probe-source", async () => ({
        container: "mov",
        codec: "prores",
        durationSec: 612,
        sizeBytes: 1024 * 1024 * 512,
        streams: 3,
      }))
      await ctx.log("Probed source", { durationSec: probe.durationSec, codec: probe.codec })
      await ctx.step("allocate-workers", async () => ({
        pool: "gpu-encode",
        nodes: 4,
        region: "us-east-1",
      }))
      if (job.data.mode === "fail") {
        await ctx.step("transcode", async () => {
          throw new Error(
            "ffmpeg exited with code 1: Unsupported codec parameters for stream 0:0 (prores_ks @ 4444xq, 12-bit)",
          )
        })
      }
      const renditions = await ctx.step("transcode", async () => ({
        outputs: [
          { label: "2160p", bitrateKbps: 16000 },
          { label: "1080p", bitrateKbps: 8000 },
          { label: "720p", bitrateKbps: 4000 },
          { label: "480p", bitrateKbps: 1500 },
        ],
        frames: 18360,
      }))
      await ctx.log("Transcode finished", {
        renditions: renditions.outputs.length,
        frames: renditions.frames,
      })
      if (job.data.mode === "sleep") {
        await ctx.sleep("await-cdn-propagation", "25m")
      }
      const thumbs = await ctx.step("extract-thumbnails", async () => ({
        count: 12,
        sprite: `https://cdn.example.com/sprites/${job.data.id}.jpg`,
      }))
      const upload = await ctx.step("upload-cdn", async () => ({
        master: `https://cdn.example.com/hls/${job.data.id}/master.m3u8`,
        regions: ["us-east", "eu-west", "ap-south"],
      }))
      await ctx.step("notify-subscribers", async () => ({ notified: 1843, channel: "push" }))
      await ctx.log("Pipeline complete")
      return {
        hls: upload.master,
        renditions: renditions.outputs.map((o) => o.label),
        thumbnails: thumbs.count,
      }
    },
    { connection, concurrency: 4 },
  )

  await queue.add("encode", { id: "movie-001", mode: "complete" }, { jobId: "movie-001" })
  await queue.add("encode", { id: "movie-002", mode: "complete" }, { jobId: "movie-002" })
  await queue.add("encode", { id: "trailer-009", mode: "sleep" }, { jobId: "trailer-009" })
  await queue.add("encode", { id: "promo-103", mode: "fail" }, { jobId: "promo-103" })

  await sleep(4200)
  await worker.close()

  // A legit `retrying` instance: completed steps + a high-attempt poll, with a
  // real future resume tick scheduled so it isn't flagged as an orphan.
  await writeRetrying(redis, {
    instanceId: "media:movie-770",
    queueName: "media",
    jobName: "encode",
    originalJobId: "movie-770",
    input: { id: "movie-770", mode: "complete" },
    completed: [
      { key: "probe-source", result: { container: "mp4", codec: "h264", durationSec: 1380 } },
      { key: "allocate-workers", result: { pool: "gpu-encode", nodes: 8 } },
      { key: "transcode", result: { outputs: 4, frames: 41400 } },
    ],
    current: { key: "poll-encoder", attempts: 14, nextRunInMs: 90_000 },
    logs: [
      "Encode request for movie-770",
      "Probed source",
      "Transcode finished",
      "Submitted to encoder farm",
      "Encoder busy — retrying",
      "Encoder busy — retrying",
    ],
  })
  await queue.scheduleResume({
    instanceId: "media:movie-770",
    queueName: "media",
    jobName: "encode",
    jobData: { id: "movie-770", mode: "complete" },
    originalJobId: "movie-770",
    resumeSeq: 14,
    delayMs: 90_000,
    reason: "retry:poll-encoder",
  })

  // A `resume_missed` instance: nextRunAt is well in the past (no live resume).
  await writeRetrying(redis, {
    instanceId: "media:movie-771",
    queueName: "media",
    jobName: "encode",
    originalJobId: "movie-771",
    input: { id: "movie-771", mode: "complete" },
    completed: [{ key: "probe-source", result: { container: "mkv", codec: "av1" } }],
    current: { key: "poll-encoder", attempts: 9, nextRunInMs: -42 * 60 * 1000 },
    logs: ["Encode request for movie-771", "Encoder busy — retrying"],
  })

  // A pristine *completed* multi-step run — the clearest showcase of the
  // execution waterfall (proportional step bars + per-step logs), mirroring a
  // transcribe pipeline (download → convert → transcribe).
  await writeCompletedRun(redis, {
    instanceId: "media:transcribe-941",
    queueName: "media",
    jobName: "transcribe-video",
    originalJobId: "transcribe-941",
    input: { videoUrl: "https://cdn.example.com/raw/keynote-941.mp4", language: "en" },
    output: { words: 1240, durationSec: 612, language: "en", confidence: 0.98 },
    steps: [
      {
        key: "downloadFile",
        durationMs: 620,
        result: { bytes: 566231, path: "/var/folders/_3/78lxy/T/keynote-941.mp4" },
        logs: [
          { message: "Video downloaded 0.54MB", atMs: 420 },
          { message: "Saved to file /var/folders/_3/78lxy/T/keynote-941.mp4", atMs: 600 },
        ],
      },
      {
        key: "convertToWav",
        durationMs: 240,
        result: { path: "/var/folders/_3/78lxy/T/keynote-941.wav", sampleRate: 16000 },
        logs: [
          { message: "ffmpeg convert to WAV", atMs: 40 },
          { message: "WAV file saved to /var/folders/_3/78lxy/T/keynote-941.wav", atMs: 220 },
        ],
      },
      {
        key: "deepgram.transcribeFile",
        durationMs: 4350,
        result: { words: 1240, confidence: 0.98, model: "nova-2" },
        logs: [
          { message: "POST https://api.deepgram.com/v1/listen", atMs: 60 },
          { message: "Transcript ready — 1,240 words @ 98% confidence", atMs: 4300 },
        ],
      },
    ],
  })

  await queue.close()
}

/**
 * A 3-level FlowProducer DAG processed by a worker that completes most children
 * but OOM-kills one rendition — so the flow graph shows a realistic mix of
 * completed / failed / waiting-children.
 */
async function seedMediaFlow(): Promise<void> {
  const flow = new FlowProducer({ connection })
  await flow.add({
    name: "publish-title",
    queueName: "media-flow",
    data: { title: "Dune: Part Three", id: "title-7" },
    opts: { jobId: "title-7" },
    children: [
      {
        name: "encode-renditions",
        queueName: "media-flow",
        data: { profile: "premium" },
        children: [
          { name: "encode-2160p", queueName: "media-flow", data: { res: "2160p" } },
          { name: "encode-1080p", queueName: "media-flow", data: { res: "1080p" } },
          { name: "encode-720p", queueName: "media-flow", data: { res: "720p" } },
        ],
      },
      { name: "generate-captions", queueName: "media-flow", data: { langs: ["en", "es", "fr"] } },
      { name: "drm-package", queueName: "media-flow", data: { scheme: "widevine" } },
    ],
  })
  await flow.close()

  const worker = new Worker(
    "media-flow",
    async (job) => {
      await sleep(25)
      if (job.name === "encode-720p") {
        throw new Error("Encoder node ran out of memory (OOMKilled)")
      }
      return { ok: true, step: job.name, finishedAt: new Date().toISOString() }
    },
    { connection, concurrency: 4 },
  )
  await sleep(2200)
  await worker.close()
}

// ---------------------------------------------------------------------------
// Schedulers + metrics (basic-BullMQ feature showcase)
// ---------------------------------------------------------------------------

/**
 * Build a parent → children → grandchildren job tree with a FlowProducer on a
 * worker-less `orders` queue, so the parent sits in `waiting-children` and the
 * Flows page + job flow tree have something real to render.
 */
async function seedFlows(): Promise<void> {
  const flow = new FlowProducer({ connection })
  await flow.add({
    name: "fulfill-order",
    queueName: "orders",
    data: { orderId: "ord_1001", total: 12900 },
    opts: { jobId: "ord_1001" },
    children: [
      { name: "charge-card", queueName: "orders", data: { amountCents: 12900 } },
      {
        name: "reserve-stock",
        queueName: "orders",
        data: { sku: "SKU-42", qty: 2 },
        children: [
          { name: "check-warehouse", queueName: "orders", data: { region: "us-east" } },
          { name: "check-warehouse", queueName: "orders", data: { region: "us-west" } },
        ],
      },
      { name: "send-receipt", queueName: "orders", data: { to: "ada@example.com" } },
    ],
  })
  await flow.close()
}

/** Register a few job schedulers (cron + interval) on the plain queues. */
async function seedSchedulers(): Promise<void> {
  const emails = new Queue("emails", { connection })
  await emails.upsertJobScheduler(
    "daily-digest",
    { pattern: "0 9 * * *", tz: "UTC" },
    { name: "digest", data: { template: "daily" } },
  )
  await emails.upsertJobScheduler("heartbeat", { every: 30_000 }, { name: "ping", data: {} })
  await emails.close()

  const payments = new Queue("payments", { connection })
  await payments.upsertJobScheduler(
    "nightly-reconcile",
    { pattern: "0 2 * * *", tz: "America/New_York" },
    { name: "reconcile", data: { scope: "all" } },
  )
  await payments.close()
}

/**
 * Fake a per-minute throughput history by writing BullMQ's metrics keys
 * directly (the worker only opts in via `metrics: {...}`, which the seed's
 * short-lived workers don't run long enough to populate). Layout mirrors
 * bullmq's `getMetrics`: a `count/prevTS/prevCount` meta hash + a `:data` list
 * whose head is the most recent minute.
 */
async function seedMetrics(redis: Redis): Promise<void> {
  for (const q of ["emails", "payments", "checkout"]) {
    const completed: number[] = []
    const failed: number[] = []
    // ~2h of per-minute history so the time-range selector is meaningful.
    for (let i = 0; i < 120; i++) {
      const base = 18 + Math.round(12 * Math.sin(i / 7))
      completed.push(Math.max(0, base + Math.floor(Math.random() * 8)))
      failed.push(Math.random() < 0.35 ? Math.floor(Math.random() * 3) : 0)
    }
    const now = Date.now()
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    await redis.del(`bull:${q}:metrics:completed:data`, `bull:${q}:metrics:failed:data`)
    await redis.rpush(`bull:${q}:metrics:completed:data`, ...completed.map(String))
    await redis.rpush(`bull:${q}:metrics:failed:data`, ...failed.map(String))
    await redis.hset(`bull:${q}:metrics:completed`, {
      count: sum(completed),
      prevTS: now,
      prevCount: completed[0] ?? 0,
    })
    await redis.hset(`bull:${q}:metrics:failed`, {
      count: sum(failed),
      prevTS: now,
      prevCount: failed[0] ?? 0,
    })
  }
}

/**
 * Seed a handful of default alert rules under the cockpit prefix so the Alerts
 * page lights up immediately (several will be firing against the seed data).
 */
async function seedAlerts(redis: Redis): Promise<void> {
  const COCKPIT_PREFIX = "bullmq-cockpit"
  const now = Date.now()
  const rules = [
    {
      id: "seed-payments-failed",
      name: "Payments failing",
      metric: "failed",
      queue: "payments",
      operator: "gt",
      threshold: 0,
      enabled: true,
      channels: [],
      createdAt: now,
    },
    {
      id: "seed-backlog",
      name: "Backlog building up",
      metric: "backlog",
      operator: "gt",
      threshold: 3,
      enabled: true,
      channels: [],
      createdAt: now + 1,
    },
    {
      id: "seed-no-workers",
      name: "Queue with no workers",
      metric: "no_workers",
      operator: "gt",
      threshold: 0,
      enabled: true,
      channels: [],
      createdAt: now + 2,
    },
    {
      id: "seed-stuck",
      name: "Durable stuck instances",
      metric: "stuck",
      operator: "gt",
      threshold: 0,
      enabled: true,
      channels: [],
      createdAt: now + 3,
    },
    {
      id: "seed-active-idle",
      name: "Emails backlog watch",
      metric: "waiting",
      queue: "emails",
      operator: "gte",
      threshold: 50,
      enabled: false,
      channels: [],
      createdAt: now + 4,
    },
  ]
  const entries: string[] = []
  for (const r of rules) entries.push(r.id, JSON.stringify(r))
  await redis.del(`${COCKPIT_PREFIX}:alert:rules`, `${COCKPIT_PREFIX}:alert:state`)
  await redis.hset(`${COCKPIT_PREFIX}:alert:rules`, ...entries)
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const redis = new Redis({ ...connection, maxRetriesPerRequest: null })
  redis.on("error", () => {})

  process.stdout.write(`Seeding redis at ${url.host}${RESET ? " (reset)" : ""}…\n`)
  if (RESET) await redis.flushdb()

  await seedProcessedQueue("emails", [
    {
      jobId: "email-ok-1",
      jobName: "welcome",
      data: { to: "ada@example.com", template: "welcome" },
    },
    {
      jobId: "email-ok-2",
      jobName: "welcome",
      data: { to: "grace@example.com", template: "welcome" },
    },
    {
      jobId: "email-ok-3",
      jobName: "digest",
      data: { to: "linus@example.com", template: "weekly" },
    },
    {
      jobId: "email-fail-1",
      jobName: "welcome",
      data: { to: "void@invalid", __failReason: "SMTP connection timed out after 30s" },
      fail: true,
    },
  ])

  await seedProcessedQueue("payments", [
    {
      jobId: "pay-ok-1",
      jobName: "charge",
      data: { userId: "user_1", amountCents: 2400, currency: "USD" },
    },
    {
      jobId: "pay-ok-2",
      jobName: "charge",
      data: { userId: "user_2", amountCents: 9900, currency: "USD" },
    },
    {
      jobId: "pay-fail-1",
      jobName: "charge",
      data: {
        userId: "user_3",
        amountCents: 1500,
        __failReason: "Card declined (insufficient_funds)",
      },
      fail: true,
    },
  ])

  await seedPendingQueue("notifications", [
    { jobId: "notif-wait-1", jobName: "digest", data: { period: "daily" } },
    { jobId: "notif-wait-2", jobName: "digest", data: { period: "weekly" } },
    { jobId: "notif-wait-3", jobName: "push", data: { device: "ios" } },
    { jobId: "notif-delay-1", jobName: "reminder", data: { in: "1h" }, delayMs: 60 * 60 * 1000 },
    { jobId: "notif-delay-2", jobName: "reminder", data: { in: "30m" }, delayMs: 30 * 60 * 1000 },
  ])

  await seedPendingQueue("exports-csv", [
    { jobId: "csv-wait-1", jobName: "users", data: { rows: 12000 } },
    { jobId: "csv-wait-2", jobName: "orders", data: { rows: 88000 } },
    { jobId: "csv-delay-1", jobName: "audit", data: { range: "2026-Q1" }, delayMs: 45 * 60 * 1000 },
  ])

  // The heavy worker-driven fixtures are independent — run them concurrently.
  await Promise.all([
    seedGeneration(redis),
    seedExports(),
    seedMediaPipeline(redis),
    seedCheckout(),
  ])
  await Promise.all([seedFlows(), seedMediaFlow()])
  await seedSchedulers()
  await seedMetrics(redis)
  await seedAlerts(redis)

  await redis.quit()
  process.stdout.write(
    "\n✓ Seed complete.\n" +
      "  Plain queues : emails, payments (completed+failed), notifications, exports-csv (waiting+delayed)\n" +
      "  checkout     : logs + large payload + retry-stacktrace + 55-job bulk + prioritized/delayed\n" +
      "  Flows        : orders (3-level, all waiting) · media-flow (mixed: completed/failed/waiting-children)\n" +
      "  Schedulers   : emails (daily-digest cron, heartbeat interval), payments (nightly-reconcile cron)\n" +
      "  Metrics      : emails, payments, checkout (~2h of completed/failed throughput)\n" +
      "  Alerts       : 4 active rules (payments-failed, backlog, no-workers, durable-stuck)\n" +
      "  Durable      : generation (completed×4, sleeping×2, retrying, failed, cancelled, stuck, orphan)\n" +
      "                 exports (completed×2, sleeping)\n" +
      "                 media (6-step pipeline: completed×2, sleeping, failed, retrying×1, resume-missed×1)\n" +
      "  Next: pnpm --filter bullmq-cockpit dev   → http://localhost:3010\n\n",
  )
  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
