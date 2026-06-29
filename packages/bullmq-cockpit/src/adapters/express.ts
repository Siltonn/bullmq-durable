/**
 * Express adapter.
 *
 *   import { createBullMQCockpit } from "bullmq-cockpit/express"
 *
 *   app.use("/admin/bullmq", createBullMQCockpit({ connection, queues: [...] }))
 *
 * Mounting strips the base path from `req.url`, and `req.baseUrl` reports where
 * it was mounted — so the cockpit's `basePath` is inferred automatically unless
 * you set it explicitly.
 */

import type { NextFunction, Request as ExpressRequest, RequestHandler, Response } from "express"
import { createCockpitApp } from "../server/app"
import { normalizeBasePath, type BullMQCockpitOptions } from "../server/options"
import { nodeToWebRequest, readNodeBody, sendWebResponse } from "./node-bridge"

export type { BullMQCockpitOptions } from "../server/options"

/** An Express handler with a `close()` for releasing the cockpit's connections. */
export type CockpitRequestHandler = RequestHandler & { close: () => Promise<void> }

export function createBullMQCockpit(options: BullMQCockpitOptions): CockpitRequestHandler {
  const explicitBase = options.basePath !== undefined
  const cockpit = createCockpitApp(options)

  const handler: RequestHandler = async (
    req: ExpressRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      // Infer the mount path from Express unless the caller fixed it.
      if (!explicitBase) cockpit.options.basePath = normalizeBasePath(req.baseUrl || "")
      const body = await readNodeBody(req)
      const request = nodeToWebRequest(req, req.url || "/", body)
      const response = await cockpit.app.fetch(request)
      await sendWebResponse(res, response)
    } catch (err) {
      next(err)
    }
  }

  return Object.assign(handler, { close: () => cockpit.context.close() })
}
