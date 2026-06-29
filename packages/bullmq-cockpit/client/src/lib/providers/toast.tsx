/**
 * A minimal, self-contained toast system (no extra dependency). Used to give
 * operators immediate feedback on actions — "Job retried", "Instance resumed",
 * or an error message when an action fails.
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { CockpitIcon, type IconName } from "@/lib/icons"

type ToastType = "success" | "error" | "info"

interface ToastInput {
  message: string
  type?: ToastType
}

interface ToastItem extends Required<ToastInput> {
  id: number
}

const ToastContext = createContext<(input: ToastInput) => void>(() => {})

export function useToast(): (input: ToastInput) => void {
  return useContext(ToastContext)
}

const ICON: Record<ToastType, IconName> = {
  success: "success",
  error: "alert",
  info: "info",
}

const ACCENT: Record<ToastType, string> = {
  success: "border-success-200 text-success",
  error: "border-danger-200 text-danger",
  info: "border-default-200 text-foreground-500",
}

let counter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    ({ message, type = "info" }: ToastInput) => {
      const id = ++counter
      setToasts((current) => [...current, { id, message, type }])
      setTimeout(() => dismiss(id), 4000)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`glass-card pointer-events-auto flex items-start gap-2.5 rounded-medium p-3 shadow-medium ${ACCENT[toast.type]}`}
          >
            <CockpitIcon name={ICON[toast.type]} width={18} className="mt-0.5 shrink-0" />
            <p className="flex-1 text-sm text-foreground-700">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="text-foreground-400 transition-colors hover:text-foreground"
              aria-label="Dismiss"
            >
              <CockpitIcon name="close" width={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
