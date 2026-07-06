/**
 * Public options and their normalized, defaulted form.
 *
 * Every adapter (`express`, `fastify`, `nestjs`, `standalone`, the CLI) funnels
 * its configuration through {@link normalizeOptions} so the rest of the server
 * only ever deals with a fully-resolved {@link NormalizedCockpitOptions}.
 */

import type { ConnectionOptions } from "bullmq"
import type { BoardPermission, BoardUser } from "../shared/dto"
import { DEFAULT_DURABLE_PREFIX } from "bullmq-durable"

/** The cockpit's own version string, surfaced in the UI footer. */
export const COCKPIT_VERSION = "0.2.0"

/** Default "stale" threshold for stuck detection: 5 minutes. */
export const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Context handed to the {@link AuthHandler} for every request. */
export interface AuthContext {
  method: string
  /** Path *within* the cockpit (the mount base is already stripped). */
  path: string
  /** Case-insensitive header accessor. */
  header(name: string): string | undefined
  /**
   * The raw, framework-specific request object, when available (Express `req`,
   * the Node `IncomingMessage`, …). Lets auth hooks read `req.user` etc.
   */
  req?: unknown
}

/**
 * The result of an auth check. `true`/`false` is the simple allow/deny form;
 * the object form additionally carries the principal and an explicit permission
 * set. When permissions are omitted, an allowed principal receives every
 * permission (subject to {@link BullMQCockpitOptions.readonly}).
 */
export type AuthResult =
  | boolean
  | {
      allowed: boolean
      user?: BoardUser
      permissions?: BoardPermission[]
    }

export type AuthHandler = (ctx: AuthContext) => Promise<AuthResult> | AuthResult

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface DurableCockpitOptions {
  /**
   * Enable the durable instance inspector. Defaults to `"auto"`: probe Redis
   * for durable state (one variadic `EXISTS` on runtime-published marker keys,
   * re-checked periodically on the shared client — never a SCAN, no extra
   * connection) and light the durable UI up only when `bullmq-durable` is
   * actually in use. `true` forces it on; `false` disables it entirely.
   */
  enabled?: boolean | "auto"
  /** Redis key prefix used by `bullmq-durable`. Defaults to `"bullmq-durable"`. */
  prefix?: string
  /**
   * How long a `running`/`yielded` instance may go without an update before the
   * health inspector flags it as stale. Defaults to 5 minutes.
   */
  stuckThresholdMs?: number
}

export interface AlertsCockpitOptions {
  /**
   * Run the background alert evaluator that dispatches notifications to channels
   * on ok→firing transitions. The Alerts dashboard works regardless (it
   * evaluates live per request); this only governs the notifier. Defaults to
   * `true`.
   */
  enabled?: boolean
  /** Evaluation cadence for the notifier, in ms. Defaults to 60s (min 10s). */
  intervalMs?: number
}

export interface BullMQCockpitOptions {
  /** A BullMQ-compatible Redis connection (ioredis options or an instance). */
  connection: ConnectionOptions
  /**
   * Queue names to expose. When omitted, the cockpit auto-discovers queues once
   * at startup by scanning BullMQ's `*:meta` keys, then caches that set for the
   * process lifetime (queues created later need a restart to appear). Pass this
   * list in production to skip the scan entirely.
   *
   * A **function** may be supplied instead of an array: it is called on each
   * request to resolve the current allow-list, and (being present) disables
   * auto-discovery. This is how the NestJS module accumulates queues registered
   * by `registerQueue` across feature modules.
   */
  queues?: string[] | (() => string[])
  /** BullMQ's key prefix (the `bull` namespace). Defaults to `"bull"`. */
  bullPrefix?: string
  /**
   * Redis key prefix for the cockpit's *own* state (alert rules & channels).
   * Defaults to `"bullmq-cockpit"`.
   */
  cockpitPrefix?: string
  /**
   * Mount path, e.g. `/admin/bullmq`. Adapters normally derive this from where
   * the app is mounted; set it explicitly only when that cannot be inferred.
   */
  basePath?: string
  /** Durable inspector configuration. */
  durable?: DurableCockpitOptions
  /** Alert evaluator / notifier configuration. */
  alerts?: AlertsCockpitOptions
  /**
   * Authorization hook. When omitted the dashboard is **open** — always set this
   * in production. Returning a falsy/`{ allowed: false }` result yields `403`.
   */
  auth?: AuthHandler
  /** Global read-only switch: disables every mutating action. */
  readonly?: boolean
  /**
   * Absolute path to the built client (`dist/client`). Defaults to the bundled
   * client shipped with the package; override only for advanced embedding.
   */
  clientDir?: string
}

// ---------------------------------------------------------------------------
// Normalized options
// ---------------------------------------------------------------------------

export interface NormalizedDurableOptions {
  enabled: boolean | "auto"
  prefix: string
  stuckThresholdMs: number
}

export interface NormalizedAlertsOptions {
  enabled: boolean
  intervalMs: number
}

export interface NormalizedCockpitOptions {
  connection: ConnectionOptions
  /**
   * Explicit queue allow-list (or a function resolving one per request), or
   * `null` to auto-discover.
   */
  queues: string[] | (() => string[]) | null
  bullPrefix: string
  cockpitPrefix: string
  basePath: string
  durable: NormalizedDurableOptions
  alerts: NormalizedAlertsOptions
  auth: AuthHandler
  readonly: boolean
  clientDir: string | null
  version: string
}

/**
 * Normalize a base path:
 *  - `undefined`, `""`, `"/"` → `""` (mounted at root)
 *  - otherwise → leading slash, no trailing slash (`/admin/bullmq`)
 */
export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === "/") return ""
  let path = basePath.trim()
  if (!path.startsWith("/")) path = `/${path}`
  if (path.endsWith("/")) path = path.slice(0, -1)
  return path
}

/** Default auth hook: allow everything. Logged so it is never a silent surprise. */
const allowAll: AuthHandler = () => true

export function normalizeOptions(options: BullMQCockpitOptions): NormalizedCockpitOptions {
  if (!options.connection) {
    throw new Error("bullmq-cockpit: `connection` is required")
  }

  if (!options.auth && !options.readonly) {
    console.warn(
      "bullmq-cockpit: no `auth` configured — every request gets full (write) access. " +
        "Set `auth` (or at least `readonly: true`) before exposing the dashboard beyond localhost.",
    )
  }

  return {
    connection: options.connection,
    queues:
      typeof options.queues === "function"
        ? options.queues
        : options.queues && options.queues.length > 0
          ? [...options.queues]
          : null,
    bullPrefix: options.bullPrefix ?? "bull",
    cockpitPrefix: options.cockpitPrefix ?? "bullmq-cockpit",
    basePath: normalizeBasePath(options.basePath),
    durable: {
      enabled: options.durable?.enabled ?? "auto",
      prefix: options.durable?.prefix ?? DEFAULT_DURABLE_PREFIX,
      stuckThresholdMs: options.durable?.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS,
    },
    alerts: {
      enabled: options.alerts?.enabled ?? true,
      intervalMs: Math.max(10_000, options.alerts?.intervalMs ?? 60_000),
    },
    auth: options.auth ?? allowAll,
    readonly: options.readonly ?? false,
    clientDir: options.clientDir ?? null,
    version: COCKPIT_VERSION,
  }
}
