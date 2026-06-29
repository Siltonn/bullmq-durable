/**
 * Promise-based confirmation. One provider hosts a single dialog; any component
 * calls `await confirm({...})` to gate a risky action:
 *
 *   const confirm = useConfirm()
 *   if (await confirm({ title: "Cancel instance?", confirmColor: "warning" })) {
 *     action.mutate(() => api.durableCancel(id))
 *   }
 *
 * This keeps every mutating action one line away from a guard, so we can require
 * confirmation consistently instead of sprinkling ad-hoc dialog state around.
 */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"

export interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel?: string
  confirmColor?: "primary" | "danger" | "warning"
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(async () => false)

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext)
}

const EMPTY: ConfirmOptions = { title: "" }

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions>(EMPTY)
  const [open, setOpen] = useState(false)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((next) => {
    setOptions(next)
    setOpen(true)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = (ok: boolean) => {
    setOpen(false)
    resolver.current?.(ok)
    resolver.current = null
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        isOpen={open}
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
        title={options.title}
        body={options.body}
        confirmLabel={options.confirmLabel}
        confirmColor={options.confirmColor}
      />
    </ConfirmContext.Provider>
  )
}
