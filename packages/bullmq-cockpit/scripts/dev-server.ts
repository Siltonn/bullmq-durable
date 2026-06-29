/**
 * The dev-mode API server. Vite serves the SPA and proxies `/api` here, so this
 * only needs to run the Hono app at the root. Launched by the `dev` script
 * (concurrently, alongside Vite).
 */

import { Redis } from "ioredis"
import { startCockpit } from "../src/adapters/standalone"

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"
const port = Number(process.env.COCKPIT_DEV_API_PORT ?? 3011)

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })
connection.on("error", (err) => {
  if (process.env.COCKPIT_DEBUG) process.stderr.write(`[cockpit:api] redis error: ${err.message}\n`)
})

const queues = process.env.COCKPIT_QUEUES?.split(",")
  .map((q) => q.trim())
  .filter(Boolean)

const cockpit = startCockpit({
  connection,
  queues: queues && queues.length > 0 ? queues : undefined,
  basePath: "",
  port,
  durable: { enabled: process.env.COCKPIT_NO_DURABLE !== "1" },
})

process.stdout.write(`[cockpit:api] listening on http://127.0.0.1:${port} (redis: ${redisUrl})\n`)

const shutdown = async () => {
  await cockpit.close()
  await connection.quit().catch(() => undefined)
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
