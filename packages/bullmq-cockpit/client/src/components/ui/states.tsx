/** Empty / error / loading placeholders shared across pages. */

import { Button, Spinner } from "@heroui/react"
import { ApiError } from "@/lib/api"
import { CockpitIcon, type IconName } from "@/lib/icons"

export function EmptyState({
  icon = "inbox",
  title,
  description,
}: {
  icon?: IconName
  title: string
  description?: string
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <CockpitIcon name={icon} width={40} className="text-foreground-300" />
      <h3 className="text-base font-medium text-foreground-600">{title}</h3>
      {description && <p className="max-w-sm text-sm text-foreground-400">{description}</p>}
    </div>
  )
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center px-6 py-16">
      <Spinner label={label} color="primary" />
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Something went wrong"
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <CockpitIcon name="alert" width={36} className="text-danger" />
      <div>
        <h3 className="text-base font-medium text-foreground-600">Could not load data</h3>
        <p className="mt-1 max-w-md text-sm text-foreground-400">{message}</p>
      </div>
      {onRetry && (
        <Button
          size="sm"
          variant="flat"
          startContent={<CockpitIcon name="refresh" width={15} />}
          onPress={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  )
}
