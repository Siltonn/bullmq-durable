/**
 * Fastify adapter — a plugin that mounts the cockpit under its register prefix.
 *
 *   import { createBullMQCockpit } from "bullmq-cockpit/fastify"
 *
 *   await fastify.register(createBullMQCockpit({ connection }), {
 *     prefix: "/admin/bullmq",
 *   })
 *
 * The plugin reads its mount path from `fastify.prefix`, hijacks the reply to
 * write the Hono response straight to the raw socket, and closes the cockpit's
 * connections on Fastify shutdown.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import { createCockpitApp } from "../server/app"
import { normalizeBasePath, type BullMQCockpitOptions } from "../server/options"
import { nodeToWebRequest, readNodeBody, sendWebResponse, serializeParsedBody } from "./node-bridge"

export type { BullMQCockpitOptions } from "../server/options"

export function createBullMQCockpit(options: BullMQCockpitOptions): FastifyPluginAsync {
  const explicitBase = options.basePath !== undefined
  const cockpit = createCockpitApp(options)

  const plugin: FastifyPluginAsync = async (fastify) => {
    const prefix = fastify.prefix || ""
    if (!explicitBase) cockpit.options.basePath = normalizeBasePath(prefix)

    const bridge = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const path =
        prefix && request.url.startsWith(prefix)
          ? request.url.slice(prefix.length) || "/"
          : request.url
      const body =
        request.body !== undefined
          ? serializeParsedBody(request.body)
          : await readNodeBody(request.raw)

      const webReq = nodeToWebRequest(request.raw, path, body)
      const response = await cockpit.app.fetch(webReq)

      // Take over the response so Fastify does not also try to send one.
      reply.hijack()
      await sendWebResponse(reply.raw, response)
    }

    fastify.all("/", bridge)
    fastify.all("/*", bridge)

    fastify.addHook("onClose", async () => {
      await cockpit.context.close()
    })
  }

  return plugin
}
