/**
 * One hook to run a mutating API call with consistent feedback: a success toast,
 * an error toast, and query invalidation so the affected tables refresh.
 *
 *   const retry = useCockpitAction({ success: "Job retried", invalidate: [["jobs"]] })
 *   retry.mutate(() => api.retryJob(queue, id))
 */

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query"
import { ApiError } from "@/lib/api"
import { useToast } from "./toast"

export function useCockpitAction(options: { success: string; invalidate?: QueryKey[] }) {
  const queryClient = useQueryClient()
  const toast = useToast()

  return useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      toast({ message: options.success, type: "success" })
      options.invalidate?.forEach((key) => void queryClient.invalidateQueries({ queryKey: key }))
    },
    onError: (error: unknown) => {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Action failed"
      toast({ message, type: "error" })
    },
  })
}
