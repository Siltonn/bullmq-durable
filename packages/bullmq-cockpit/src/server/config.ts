/**
 * Build the per-request {@link CockpitConfig} — the bootstrap payload the client
 * reads on load. It is composed from the resolved auth state (permissions +
 * principal) and the normalized options.
 *
 * Two call sites share this one function so they never drift: the HTML shell
 * (`server/client.ts`, which injects it as `window.__BULLMQ_COCKPIT__`) and the
 * `config` tRPC procedure (which the SPA fetches in dev, where Vite — not our
 * server — serves the HTML).
 */

import type { BoardPermission, BoardUser, CockpitConfig } from "../shared/dto"
import type { BoardContext } from "./context"
import { effectivePermissions } from "./middleware/auth"

export function buildCockpitConfig(
  board: BoardContext,
  permissions: BoardPermission[],
  user: BoardUser | undefined,
): CockpitConfig {
  return {
    basePath: board.options.basePath,
    durableEnabled: board.options.durable.enabled,
    readonly: board.options.readonly,
    permissions: effectivePermissions(board, permissions),
    user,
    version: board.options.version,
  }
}
