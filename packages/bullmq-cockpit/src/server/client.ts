/**
 * Serving the built React client.
 *
 * The same Hono app serves both the JSON API and the SPA, so every adapter
 * (express / fastify / nestjs / standalone) gets identical behaviour for free.
 * Two responsibilities live here:
 *
 *  1. Static assets — content-hashed files under `/assets/*` are public and
 *     cached aggressively; other root files (favicon, …) are served as-is.
 *  2. The SPA shell — any unmatched path returns `index.html` with the per-user
 *     {@link CockpitConfig} injected as `window.__BULLMQ_COCKPIT__`, so the client
 *     knows its mount path, permissions, and feature flags before it boots.
 */

import { existsSync, readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { dirname, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context, Hono, MiddlewareHandler } from "hono"
import type { CockpitConfig } from "../shared/dto"

const CONFIG_PLACEHOLDER = "<!--__BULLMQ_COCKPIT_CONFIG__-->"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
}

function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream"
}

/**
 * Locate the built client directory (the one containing `index.html`).
 *
 * This module is bundled into each entry point, so `import.meta.url` resolves to
 * `dist/index.js`, `dist/adapters/express.js`, etc. We probe a few relative
 * candidates so the lookup works regardless of the entry's depth, and honour an
 * explicit override first.
 */
export function resolveClientDir(configured: string | null): string | null {
  const candidates: string[] = []
  if (configured) candidates.push(configured)

  try {
    const here = dirname(fileURLToPath(import.meta.url))
    candidates.push(
      join(here, "client"),
      join(here, "..", "client"),
      join(here, "..", "..", "client"),
    )
  } catch {
    // import.meta.url unavailable — fall back to cwd-relative guesses below.
  }
  candidates.push(join(process.cwd(), "dist", "client"))

  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null
}

/** Escape `<` so a value embedded in inline JS can never break out of `<script>`. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

function injectConfig(html: string, config: CockpitConfig): string {
  // A runtime <base> is essential: the client is built with relative asset URLs
  // (`./assets/…`) so it can be embedded under any mount path. Without a <base>,
  // those relative URLs resolve against the *current route's* directory, so a
  // two-segment route like `/durable/{id}` would fetch `/durable/assets/…` and
  // 404 — the bundle never loads and the page renders blank. Anchoring every
  // relative URL to `{basePath}/` fixes asset loading at any route depth.
  const baseTag = `<base href="${config.basePath || ""}/">`
  const script = `<script>window.__BULLMQ_COCKPIT__ = ${safeJson(config)};</script>`

  let out = html.includes("<head>")
    ? html.replace("<head>", `<head>${baseTag}`)
    : `${baseTag}${html}`
  out = out.includes(CONFIG_PLACEHOLDER)
    ? out.replace(CONFIG_PLACEHOLDER, script)
    : out.replace("</head>", `${script}</head>`)
  return out
}

/** A request path is "safe" if, once normalized, it stays within the root. */
function safeJoin(root: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath).replace(/^\/+/, "")
  const target = normalize(join(root, decoded))
  return target.startsWith(normalize(root)) ? target : null
}

export interface ClientServer {
  /** Register the static + SPA routes on the app. `false` if no client found. */
  available: boolean
  notFoundMessage: string
}

/**
 * Wire static + SPA handlers onto `app`. `buildConfig` is invoked per-request so
 * the injected config reflects the current principal's permissions.
 *
 * `authGuard` runs before the SPA shell (so the HTML is gated like the API) but
 * NOT before `/assets/*` (content-hashed bundles are identical for everyone and
 * need no auth round-trip).
 */
export function registerClient(
  app: Hono<any>,
  clientDir: string | null,
  buildConfig: (c: Context) => CockpitConfig | Promise<CockpitConfig>,
  authGuard: MiddlewareHandler,
): ClientServer {
  const root = resolveClientDir(clientDir)

  if (!root) {
    const message =
      "bullmq-cockpit client is not built. Run `pnpm --filter bullmq-cockpit build` (or set `clientDir`)."
    app.get("*", (c) => c.text(message, 501))
    return { available: false, notFoundMessage: message }
  }

  const indexHtml = readFileSync(join(root, "index.html"), "utf8")

  // Content-hashed bundles: public, immutable, long-lived cache.
  app.get("/assets/*", async (c) => {
    const target = safeJoin(root, c.req.path)
    if (!target || !(await isFile(target))) return c.notFound()
    const body = await readFile(target)
    return c.body(body, 200, {
      "Content-Type": contentType(target),
      "Cache-Control": "public, max-age=31536000, immutable",
    })
  })

  // Everything else: a real root file if one exists, else the SPA shell.
  app.get("*", authGuard, async (c) => {
    const target = safeJoin(root, c.req.path)
    if (target && extname(target) && (await isFile(target))) {
      const body = await readFile(target)
      return c.body(body, 200, { "Content-Type": contentType(target) })
    }
    const html = injectConfig(indexHtml, await buildConfig(c))
    return c.html(html, 200, { "Cache-Control": "no-cache" })
  })

  return { available: true, notFoundMessage: "" }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
