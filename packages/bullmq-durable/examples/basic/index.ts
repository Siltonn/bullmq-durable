/**
 * Basic example: a durable "welcome email" job.
 *
 * Shows the three building blocks — `ctx.step` (checkpointed work), `ctx.sleep`
 * (pause without holding a worker), and BullMQ-style payload typing: the queue
 * is typed by its payload (`DurableQueue<Data, Result>`) and the job name is a
 * free routing label.
 *
 * Run a Redis instance, then execute this file with `tsx` / `ts-node`.
 */

import { DurableQueue, DurableWorker, type DurableJob } from "bullmq-durable"

interface SendEmailInput {
  userId: string
}
interface SendEmailResult {
  sent: boolean
}

const connection = { host: "127.0.0.1", port: 6379 }

// The queue is typed by its payload — no name->payload map to declare.
// The run's whole record (state + logs) lives exactly as long as its job, so
// BullMQ's own cleanup options govern retention; keepLogs bounds ctx.log.
export const queue = new DurableQueue<SendEmailInput, SendEmailResult>("emails", {
  connection,
  defaultJobOptions: {
    removeOnComplete: { age: 7 * 24 * 3600 }, // keep finished runs for 7d
    removeOnFail: { age: 30 * 24 * 3600 }, // keep failed runs for 30d
    keepLogs: 1000,
  },
})

export const worker = new DurableWorker(
  "emails",
  {
    // "welcome" is just a routing label; the handler types its own payload.
    welcome: async (job: DurableJob<SendEmailInput, SendEmailResult>, ctx) => {
      // `job.data` is typed as SendEmailInput.
      const user = await ctx.step("load-user", () => loadUser(job.data.userId))

      // Wait a little without occupying the worker; the job resumes later.
      await ctx.sleep("cool-down", "5s")

      await ctx.step("send-email", () => sendEmail(user.email))

      return { sent: true }
    },
  },
  { connection },
)

export async function enqueue(): Promise<void> {
  // Using a stable jobId makes the durable instance id stable and idempotent.
  await queue.add("welcome", { userId: "u_123" }, { jobId: "welcome:u_123" })
}

// --- Fake side-effecting helpers (replace with real ones) -------------------

async function loadUser(userId: string): Promise<{ id: string; email: string }> {
  return { id: userId, email: `${userId}@example.com` }
}

async function sendEmail(email: string): Promise<{ delivered: boolean }> {
  console.log(`sending welcome email to ${email}`)
  return { delivered: true }
}
