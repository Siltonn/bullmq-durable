/** Auth / bootstrap contracts. */

/** Fine-grained capabilities, gated per request by the auth hook. */
export type BoardPermission =
  | "queue:read"
  | "queue:write"
  | "job:read"
  | "job:write"
  | "durable:read"
  | "durable:resume"
  | "durable:retry"
  | "durable:cancel"
  | "durable:delete"
  | "dangerous:write"

/** The authenticated principal, surfaced to the UI for display only. */
export interface BoardUser {
  id: string
  name?: string
  role?: string
}

/**
 * The bootstrap payload the client reads on load (also injected into the HTML
 * shell as `window.__BULLMQ_COCKPIT__`). It tells the SPA where it is mounted
 * and what the current principal is allowed to do.
 */
export interface CockpitConfig {
  /** Mount path, e.g. `/admin/bullmq`. Empty string when mounted at root. */
  basePath: string
  /** Whether a durable inspector is wired up for this deployment. */
  durableEnabled: boolean
  /** Global read-only switch — disables every mutating action. */
  readonly: boolean
  /** Effective permissions for the current principal. */
  permissions: BoardPermission[]
  /** The current principal, if the auth hook returned one. */
  user?: BoardUser
  /** Build/version string, shown in the UI footer. */
  version: string
}
