import { toJson } from "@/lib/format"
import { CopyButton } from "./copy-button"

/** A read-only, scrollable JSON block with a copy button. */
export function JsonViewer({
  value,
  maxHeight = 380,
  emptyLabel = "No data",
}: {
  value: unknown
  maxHeight?: number
  emptyLabel?: string
}) {
  if (value === undefined || value === null) {
    return <p className="text-sm text-foreground-400">{emptyLabel}</p>
  }

  const json = toJson(value)
  return (
    <div className="relative rounded-medium border border-default-200 bg-default-50/60">
      <div className="absolute right-1.5 top-1.5 z-10">
        <CopyButton value={json} label="Copy JSON" />
      </div>
      <pre
        className="overflow-auto whitespace-pre-wrap break-words p-4 pr-10 font-mono text-xs leading-relaxed text-foreground-700"
        style={{ maxHeight }}
      >
        {json}
      </pre>
    </div>
  )
}
