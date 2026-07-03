/**
 * Error helpers for tRPC failures.
 *
 * tRPC surfaces failures as {@link TRPCClientError}, which carries the server's
 * HTTP status on `data.httpStatus`. The UI branches on that (a `403` means
 * "access denied", a `404` means "not found"), so these two helpers replace the
 * old hand-rolled `ApiError` checks.
 */

import { TRPCClientError } from "@trpc/client"
import type { AppRouter } from "@server/trpc/router"

type CockpitError = TRPCClientError<AppRouter>

/** The HTTP status behind a failed call, or `undefined` if it wasn't a tRPC error. */
export function errorStatus(error: unknown): number | undefined {
  if (error instanceof TRPCClientError) {
    return (error as CockpitError).data?.httpStatus
  }
  return undefined
}

/** A human-readable message for any thrown value, with a sensible fallback. */
export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof Error) return error.message
  return fallback
}
