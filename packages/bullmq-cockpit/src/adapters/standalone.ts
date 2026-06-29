/**
 * Standalone adapter — run the cockpit as its own Node HTTP server.
 *
 *   import { startCockpit } from "bullmq-cockpit/standalone"
 *
 *   const cockpit = startCockpit({ connection, queues: [...], port: 3001 })
 *   console.log(`bullmq-cockpit on ${cockpit.url}`)
 *
 * Powers the `bullmq-cockpit` CLI. Mounted at the root, so `basePath` is empty
 * unless overridden.
 */

import { serve, type ServerType } from "@hono/node-server"
import { createCockpitApp } from "../server/app"
import type { BullMQCockpitOptions } from "../server/options"

export interface StandaloneCockpitOptions extends BullMQCockpitOptions {
  /** Port to listen on. Defaults to `3000`. */
  port?: number
  /** Host/interface to bind. Defaults to `0.0.0.0`. */
  host?: string
}

export interface StandaloneCockpit {
  /** A user-facing URL for the running dashboard. */
  url: string
  /** The underlying Node server. */
  server: ServerType
  /** Stop the server and release the cockpit's Redis connections. */
  close: () => Promise<void>
}

export function startCockpit(options: StandaloneCockpitOptions): StandaloneCockpit {
  const port = options.port ?? 3000
  const host = options.host ?? "0.0.0.0"
  const cockpit = createCockpitApp({ ...options, basePath: options.basePath ?? "" })

  const server = serve({ fetch: (req) => cockpit.app.fetch(req), port, hostname: host })
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host

  return {
    url: `http://${displayHost}:${port}`,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await cockpit.context.close()
    },
  }
}
