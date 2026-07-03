/**
 * The tRPC foundation: init, the per-request context, and the shared procedure
 * builders that encode the cockpit's authorization model.
 *
 * The routers (in `./routers`) stay thin — they parse an input, call an
 * inspector, and return the result — so *all* the cross-cutting concerns live
 * here:
 *
 *  - **auth gate** — `authedProcedure` rejects unauthenticated principals, the
 *    same way the old `/api/*` middleware did.
 *  - **permissions** — `protectedProcedure(perm)` enforces a capability (and
 *    read-only mode) by reusing the exact `requirePermission` logic.
 *  - **error mapping** — inspectors throw transport-agnostic {@link HttpError}s;
 *    `normalizeErrors` turns those into properly-coded {@link TRPCError}s so the
 *    HTTP status and error code the client sees stay identical to before.
 */

import { initTRPC, TRPCError } from "@trpc/server"
import type { BoardPermission, BoardUser } from "../../shared/dto"
import type { BoardContext } from "../context"
import { HttpError } from "../http/http-error"
import { requirePermission, resolveAuth } from "../middleware/auth"
import type { AuthContext } from "../options"

/** The context every procedure closes over — the board plus the resolved auth. */
export interface CockpitContext {
  board: BoardContext
  allowed: boolean
  permissions: BoardPermission[]
  user?: BoardUser
}

/**
 * Build the per-request context: run the host auth hook once (via the shared
 * {@link resolveAuth}) so a batched request authenticates a single time.
 */
export async function createCockpitContext(
  board: BoardContext,
  req: Request,
): Promise<CockpitContext> {
  const authCtx: AuthContext = {
    method: req.method,
    path: new URL(req.url).pathname,
    header: (name) => req.headers.get(name) ?? undefined,
    req,
  }
  const { allowed, permissions, user } = await resolveAuth(board, authCtx)
  return { board, allowed, permissions, user }
}

const t = initTRPC.context<CockpitContext>().create()

export const router = t.router
export const mergeRouters = t.mergeRouters

/** Map a transport-agnostic {@link HttpError} to the matching {@link TRPCError}. */
function toTRPCError(err: HttpError): TRPCError {
  const code =
    err.status === 400
      ? "BAD_REQUEST"
      : err.status === 403
        ? "FORBIDDEN"
        : err.status === 404
          ? "NOT_FOUND"
          : "INTERNAL_SERVER_ERROR"
  return new TRPCError({ code, message: err.message, cause: err })
}

/**
 * Rethrow {@link HttpError}s bubbling up from the inspectors (or the permission
 * check) as properly-coded tRPC errors. tRPC wraps any non-TRPCError as an
 * INTERNAL_SERVER_ERROR with the original on `.cause`, so we inspect that.
 */
const normalizeErrors = t.middleware(async ({ next }) => {
  const result = await next()
  if (!result.ok && result.error.cause instanceof HttpError) {
    throw toTRPCError(result.error.cause)
  }
  return result
})

/** Reject unauthenticated principals up-front (the old `/api/*` auth gate). */
const enforceAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Not authorized to access bullmq-cockpit",
    })
  }
  return next()
})

/** Base procedure: auth-agnostic, but with inspector errors mapped correctly. */
export const publicProcedure = t.procedure.use(normalizeErrors)

/** An authenticated procedure (no specific capability required — e.g. config). */
export const authedProcedure = publicProcedure.use(enforceAuth)

/**
 * A procedure that additionally requires `permission`. Read-only mode and the
 * granted permission set are enforced by the shared {@link requirePermission},
 * so authorization behaves exactly as it did for the REST routes.
 */
export function protectedProcedure(permission: BoardPermission) {
  return authedProcedure.use(({ ctx, next }) => {
    requirePermission(ctx.board, ctx.permissions, permission)
    return next()
  })
}
