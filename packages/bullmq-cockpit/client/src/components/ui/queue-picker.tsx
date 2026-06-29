import { Autocomplete, AutocompleteItem } from "@heroui/react"
import { CockpitIcon } from "@/lib/icons"

interface QueueOption {
  name: string
}

/**
 * A searchable queue picker (type to filter) — far easier than a plain dropdown
 * once there are many queues. `allowAll` makes it clearable (cleared = "all").
 */
export function QueuePicker({
  queues,
  value,
  onChange,
  allowAll = false,
  label,
  className,
}: {
  queues: QueueOption[]
  value?: string
  onChange: (queue?: string) => void
  allowAll?: boolean
  label?: string
  className?: string
}) {
  return (
    <Autocomplete
      // Re-key on the queue set so async-loaded items populate the collection.
      key={queues.map((q) => q.name).join("|")}
      aria-label="Queue"
      label={label}
      labelPlacement="outside"
      size="md"
      variant="bordered"
      className={className}
      placeholder={allowAll ? "All queues" : "Select a queue"}
      defaultItems={queues}
      selectedKey={value ?? null}
      onSelectionChange={(key) => onChange(key == null ? undefined : String(key))}
      isClearable={allowAll}
      startContent={<CockpitIcon name="queues" width={17} className="text-foreground-400" />}
    >
      {(q) => (
        <AutocompleteItem key={q.name} textValue={q.name}>
          {q.name}
        </AutocompleteItem>
      )}
    </Autocomplete>
  )
}
