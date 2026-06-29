#!/usr/bin/env node
/**
 * The `bullmq-cockpit` standalone CLI.
 *
 *   npx bullmq-cockpit --redis redis://localhost:6379 --queues generation,persona --port 3001
 */

import { parseArgs } from "node:util"
import { Redis } from "ioredis"
import { startCockpit } from "../adapters/standalone"
import { COCKPIT_VERSION } from "../server/options"

const HELP = `bullmq-cockpit v${COCKPIT_VERSION} — modern dashboard for BullMQ

Usage:
  bullmq-cockpit [options]

Options:
  --redis <url>            Redis connection URL          (default: redis://127.0.0.1:6379)
  --queues <a,b,c>         Comma-separated queue names   (default: auto-discover)
  --port <number>          Port to listen on             (default: 3000)
  --host <host>            Host/interface to bind        (default: 0.0.0.0)
  --base-path <path>       Mount the UI under a sub-path (default: /)
  --bull-prefix <prefix>   BullMQ key prefix             (default: bull)
  --durable-prefix <p>     bullmq-durable key prefix     (default: bullmq-durable)
  --no-durable             Disable the durable inspector
  --readonly               Disable every mutating action
  -h, --help               Show this help
  -v, --version            Show the version
`

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      redis: { type: "string" },
      queues: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "base-path": { type: "string" },
      "bull-prefix": { type: "string" },
      "durable-prefix": { type: "string" },
      "no-durable": { type: "boolean" },
      readonly: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(HELP)
    return
  }
  if (values.version) {
    process.stdout.write(`${COCKPIT_VERSION}\n`)
    return
  }

  const redisUrl = values.redis ?? "redis://127.0.0.1:6379"
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })

  const cockpit = startCockpit({
    connection,
    queues: parseList(values.queues),
    port: values.port ? Number(values.port) : 3000,
    host: values.host,
    basePath: values["base-path"],
    bullPrefix: values["bull-prefix"],
    durable: {
      enabled: !values["no-durable"],
      prefix: values["durable-prefix"],
    },
    readonly: Boolean(values.readonly),
  })

  process.stdout.write(`\n  bullmq-cockpit v${COCKPIT_VERSION}\n`)
  process.stdout.write(`  ▸ dashboard:  ${cockpit.url}${values["base-path"] ?? ""}\n`)
  process.stdout.write(`  ▸ redis:      ${redisUrl}\n`)
  process.stdout.write(`  ▸ durable:    ${values["no-durable"] ? "disabled" : "enabled"}\n`)
  if (values.readonly) process.stdout.write(`  ▸ mode:       read-only\n`)
  process.stdout.write(`\n  Press Ctrl+C to stop.\n\n`)

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nReceived ${signal}, shutting down…\n`)
    await cockpit.close()
    await connection.quit().catch(() => undefined)
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((err) => {
  process.stderr.write(
    `bullmq-cockpit failed to start: ${err instanceof Error ? err.message : err}\n`,
  )
  process.exit(1)
})
