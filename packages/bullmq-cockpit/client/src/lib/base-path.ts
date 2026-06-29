/**
 * The mount path the dashboard is served under, read from the injected
 * `window.__BULLMQ_COCKPIT__`. Everything that builds a URL — the API client and
 * the router — derives from here, so the SPA works under any sub-path.
 */
export function getBasePath(): string {
  if (typeof window === "undefined") return ""
  return window.__BULLMQ_COCKPIT__?.basePath ?? ""
}

/** The base for all API calls, e.g. `/admin/bullmq/api`. */
export function apiBase(): string {
  return `${getBasePath()}/api`
}
