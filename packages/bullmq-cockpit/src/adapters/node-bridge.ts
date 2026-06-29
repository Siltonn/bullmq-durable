/**
 * Bridge between Node's `http` request/response objects and the Web
 * `Request`/`Response` the Hono app speaks.
 *
 * Shared by the Express, Fastify, and NestJS adapters (all Node-based). Node 18+
 * ships global `Request`/`Response`/`Headers` via undici, so no polyfill is
 * needed.
 */

import type { IncomingMessage, ServerResponse } from "node:http"

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"])

/**
 * Read the request body as a Buffer.
 *
 * Host frameworks often parse the body before we see it (Express' `json()`,
 * Fastify's content-type parser). When that has happened the raw stream is
 * already drained, so we re-serialise the parsed value instead.
 */
export async function readNodeBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method && METHODS_WITHOUT_BODY.has(req.method)) return undefined

  const parsed = (req as IncomingMessage & { body?: unknown }).body
  if (parsed !== undefined && !req.readable) {
    return serializeParsedBody(parsed)
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined
}

/** Turn an already-parsed body (object/string/Buffer) back into a Buffer. */
export function serializeParsedBody(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (Buffer.isBuffer(body)) return body
  if (typeof body === "string") return body.length > 0 ? Buffer.from(body) : undefined
  return Buffer.from(JSON.stringify(body))
}

/**
 * Build a Web `Request` from a Node request, using `urlPath` as the path the
 * Hono app should route on (already stripped of any mount prefix).
 */
export function nodeToWebRequest(
  req: IncomingMessage,
  urlPath: string,
  body: Buffer | undefined,
): Request {
  const host = req.headers.host ?? "localhost"
  const url = `http://${host}${urlPath.startsWith("/") ? urlPath : `/${urlPath}`}`

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    // Re-serialised bodies have a new length; let fetch recompute it.
    if (key.toLowerCase() === "content-length") continue
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else headers.set(key, value)
  }

  const init: RequestInit = { method: req.method ?? "GET", headers }
  // A Buffer is a valid body, but `BodyInit` is not always nameable without the
  // DOM lib, so assign through a loose cast rather than annotating it.
  if (body) (init as { body?: unknown }).body = body
  return new Request(url, init)
}

/** Pipe a Web `Response` back out through a Node `ServerResponse`. */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  res.end(buffer)
}
