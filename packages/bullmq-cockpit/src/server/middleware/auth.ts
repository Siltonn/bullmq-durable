/**
 * Authorization: the auth hook, permission model, and read-only enforcement.
 *
 * One middleware runs the host-supplied {@link AuthHandler} for every request,
 * stashing the resolved permissions/principal on the Hono context. Routes then
 * call {@link requirePermission} to gate specific actions. Write permissions are
 * additionally blocked whenever the cockpit is in read-only mode, with a distinct
 * `readonly` error so the UI can explain *why* an action is unavailable.
 */

import type { MiddlewareHandler } from "hono"
import type { BoardPermission, BoardUser } from "../../shared/dto"
import type { BoardContext } from "../context"
import { forbidden, readonly } from "../http/http-error"
import type { AuthContext, AuthResult } from "../options"

/** Every permission, granted to an allowed principal when none are specified. */
export const ALL_PERMISSIONS: BoardPermission[] = [
  "queue:read",
  "queue:write",
  "job:read",
  "job:write",
  "durable:read",
  "durable:resume",
  "durable:retry",
  "durable:cancel",
  "durable:delete",
  "dangerous:write",
]

/** The permissions that mutate state — disabled entirely in read-only mode. */
export const WRITE_PERMISSIONS = new Set<BoardPermission>([
  "queue:write",
  "job:write",
  "durable:resume",
  "durable:retry",
  "durable:cancel",
  "durable:delete",
  "dangerous:write",
])

/** Hono context variables set by {@link authMiddleware}. */
export interface CockpitVariables {
  permissions: BoardPermission[]
  user?: BoardUser
}

export interface ResolvedAuth {
  allowed: boolean
  permissions: BoardPermission[]
  user?: BoardUser
}

/** Run the host auth hook and normalize its (boolean | object) result. */
export async function resolveAuth(
  context: BoardContext,
  authCtx: AuthContext,
): Promise<ResolvedAuth> {
  const result: AuthResult = await context.options.auth(authCtx)
  if (typeof result === "boolean") {
    return { allowed: result, permissions: result ? ALL_PERMISSIONS : [] }
  }
  return {
    allowed: result.allowed,
    permissions: result.permissions ?? (result.allowed ? ALL_PERMISSIONS : []),
    user: result.user,
  }
}

/** Build the per-request auth middleware bound to a board context. */
export function authMiddleware(context: BoardContext): MiddlewareHandler {
  return async (c, next) => {
    const authCtx: AuthContext = {
      method: c.req.method,
      // Path relative to the mount point (Hono strips the base path already).
      path: c.req.path,
      header: (name) => c.req.header(name),
      req: c.req.raw,
    }

    const resolved = await resolveAuth(context, authCtx)
    if (!resolved.allowed) {
      return c.json({ error: "forbidden", message: "Not authorized to access bullmq-cockpit" }, 403)
    }

    c.set("permissions", resolved.permissions)
    if (resolved.user) c.set("user", resolved.user)
    await next()
  }
}

/**
 * Assert the current principal holds `permission`. Throws an {@link HttpError}
 * (handled centrally) — a `readonly` one for write actions in read-only mode, a
 * `forbidden` one otherwise.
 */
export function requirePermission(
  context: BoardContext,
  permissions: BoardPermission[],
  permission: BoardPermission,
): void {
  if (context.options.readonly && WRITE_PERMISSIONS.has(permission)) {
    throw readonly()
  }
  if (!permissions.includes(permission)) {
    throw forbidden(`Missing permission: ${permission}`)
  }
}

/** The effective permission set, with write perms stripped in read-only mode. */
export function effectivePermissions(
  context: BoardContext,
  permissions: BoardPermission[],
): BoardPermission[] {
  if (!context.options.readonly) return permissions
  return permissions.filter((p) => !WRITE_PERMISSIONS.has(p))
}
