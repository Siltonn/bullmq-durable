import { Button, Tooltip } from "@heroui/react"
import { useState } from "react"
import { CockpitIcon } from "@/lib/icons"

/** A small icon button that copies `value` to the clipboard with feedback. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard blocked (insecure context, permissions) — fail silently
    }
  }

  return (
    <Tooltip content={copied ? "Copied" : label} size="sm">
      <Button isIconOnly size="sm" variant="light" onPress={copy} aria-label={label}>
        <CockpitIcon name={copied ? "check" : "copy"} width={15} />
      </Button>
    </Tooltip>
  )
}
