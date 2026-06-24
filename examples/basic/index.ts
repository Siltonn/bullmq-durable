/**
 * Basic example: a durable "welcome email" job.
 *
 * Shows the three building blocks — `ctx.step` (checkpointed work), `ctx.sleep`
 * (pause without holding a worker), and a typed job map for end-to-end safety.
 *
 * Run a Redis instance, then execute this file with `tsx` / `ts-node`.
 */

import { DurableQueue, DurableWorker } from "bullmq-durable"

interface SendEmailInput {
  userId: string
}
interface SendEmailResult {
  sent: boolean
}

// A job map gives `queue.add` and the worker handlers full type inference.
type EmailJobs = {
  welcome: { data: SendEmailInput; result: SendEmailResult }
}

const connection = { host: "127.0.0.1", port: 6379 }

export const queue = new DurableQueue<EmailJobs>("emails", { connection })

export const worker = new DurableWorker<EmailJobs>(
  "emails",
  {
    welcome: async (job, ctx) => {
      // `job.data` is typed as SendEmailInput.
      const user = await ctx.step("load-user", () => loadUser(job.data.userId))

      // Wait a little without occupying the worker; the job resumes later.
      await ctx.sleep("cool-down", "5s")

      await ctx.step("send-email", () => sendEmail(user.email))

      return { sent: true }
    },
  },
  {
    connection,
    retention: { completed: "7d", failed: "30d" },
  },
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
