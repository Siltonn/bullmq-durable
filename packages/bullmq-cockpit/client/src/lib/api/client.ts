/**
 * The tRPC client — the one place the browser talks to the server.
 *
 * It is typed by the server's `AppRouter` (a **type-only** import, so no server
 * code enters the bundle), which means every procedure's inputs and outputs are
 * inferred end-to-end. There are no hand-written wire types on the client.
 */

import { createTRPCClient, httpBatchLink } from "@trpc/client"
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server"
import type { AppRouter } from "@server/trpc/router"
import { getBasePath } from "@/lib/base-path"

/** The tRPC endpoint, resolved against the runtime mount path. */
function trpcUrl(): string {
  return `${getBasePath()}/api/trpc`
}

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: trpcUrl(),
      // Send cookies so the host's auth hook sees the session, as before.
      fetch: (url, options) => fetch(url, { ...options, credentials: "include" }),
    }),
  ],
})

/** Inferred input types for every procedure (`RouterInputs["jobs"]["list"]`, …). */
export type RouterInputs = inferRouterInputs<AppRouter>
/** Inferred output types for every procedure (`RouterOutputs["queues"]["get"]`, …). */
export type RouterOutputs = inferRouterOutputs<AppRouter>
