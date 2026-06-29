import { QueryClient } from "@tanstack/react-query"

/**
 * Dashboard data is short-lived and polled, so we keep a small stale time and
 * skip refetch-on-focus (it would hammer Redis when an operator tabs back).
 * Individual lists opt into `refetchInterval` for live updates.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
