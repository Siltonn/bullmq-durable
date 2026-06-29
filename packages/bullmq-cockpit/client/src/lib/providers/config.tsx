/**
 * Cockpit config provider. The injected `window.__BULLMQ_COCKPIT__` is enough to
 * bootstrap (it gives us the base path), but the authoritative permission set,
 * read-only flag, and principal come from `GET /api/config` — that way dev mode
 * (where the HTML is served by Vite, not our server) still gets real values.
 */

import { Spinner } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { createContext, useContext, type ReactNode } from "react"
import type { BoardPermission, CockpitConfig } from "@shared/dto"
import { api, ApiError } from "@/lib/api"
import { CockpitIcon } from "@/lib/icons"

const ConfigContext = createContext<CockpitConfig | null>(null)

export function useCockpitConfig(): CockpitConfig {
  const cfg = useContext(ConfigContext)
  if (!cfg) throw new Error("useCockpitConfig must be used within <ConfigProvider>")
  return cfg
}

/** Returns a predicate for checking the current principal's permissions. */
export function usePermission(): (permission: BoardPermission) => boolean {
  const cfg = useCockpitConfig()
  return (permission) => cfg.permissions.includes(permission)
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <div className="flex h-dvh w-full items-center justify-center">
      <Spinner label={label} color="primary" />
    </div>
  )
}

function BootError({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex h-dvh w-full items-center justify-center p-6">
      <div className="max-w-md rounded-large border border-danger-200 bg-danger-50 p-6 text-center dark:bg-danger-50/10">
        <CockpitIcon name="alert" width={32} className="mx-auto text-danger" />
        <h1 className="mt-3 text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-foreground-500">{message}</p>
      </div>
    </div>
  )
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["config"],
    queryFn: api.config,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  })

  if (isLoading) return <CenteredSpinner label="Loading bullmq-cockpit…" />
  if (error || !data) {
    const forbidden = error instanceof ApiError && error.status === 403
    const message =
      error instanceof ApiError
        ? error.message
        : "Could not reach the bullmq-cockpit API. Is the server running?"
    return (
      <BootError
        title={forbidden ? "Access denied" : "Cannot reach bullmq-cockpit"}
        message={message}
      />
    )
  }

  return <ConfigContext.Provider value={data}>{children}</ConfigContext.Provider>
}
