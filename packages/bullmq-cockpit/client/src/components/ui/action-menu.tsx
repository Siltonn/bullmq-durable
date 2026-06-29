import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from "@heroui/react"
import { CockpitIcon, type IconName } from "@/lib/icons"

export interface ActionItem {
  key: string
  label: string
  icon: IconName
  onAction: () => void
  color?: "default" | "danger" | "warning"
  hidden?: boolean
  disabled?: boolean
}

/** A `⋮` overflow menu of row/entity actions. Hidden items are filtered out. */
export function ActionMenu({ items, label = "Actions" }: { items: ActionItem[]; label?: string }) {
  const visible = items.filter((item) => !item.hidden)
  if (visible.length === 0) return null

  return (
    <Dropdown placement="bottom-end">
      <DropdownTrigger>
        <Button isIconOnly size="sm" variant="light" aria-label={label}>
          <CockpitIcon name="more" width={18} />
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label={label}
        onAction={(key) => visible.find((item) => item.key === String(key))?.onAction()}
        disabledKeys={visible.filter((i) => i.disabled).map((i) => i.key)}
      >
        {visible.map((item) => (
          <DropdownItem
            key={item.key}
            color={item.color === "danger" ? "danger" : "default"}
            className={item.color === "danger" ? "text-danger" : undefined}
            startContent={<CockpitIcon name={item.icon} width={16} />}
          >
            {item.label}
          </DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  )
}
