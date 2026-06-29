import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Switch,
} from "@heroui/react"
import { useEffect, useState } from "react"
import {
  type AlertChannel,
  type AlertMetric,
  type AlertOperator,
  type AlertRule,
} from "@shared/dto"
import { QueuePicker } from "@/components/ui/queue-picker"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { METRICS, OPERATORS } from "@/features/alerts/config/constants"

export function AlertRuleModal({
  rule,
  queues,
  channels,
  isOpen,
  onClose,
}: {
  rule: AlertRule | null
  queues: { name: string }[]
  channels: AlertChannel[]
  isOpen: boolean
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [metric, setMetric] = useState<AlertMetric>("failed")
  const [queue, setQueue] = useState<string | undefined>(undefined)
  const [operator, setOperator] = useState<AlertOperator>("gt")
  const [threshold, setThreshold] = useState("0")
  const [enabled, setEnabled] = useState(true)
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())

  // Hydrate from the rule being edited (or reset for a new rule) on open.
  useEffect(() => {
    if (!isOpen) return
    setName(rule?.name ?? "")
    setMetric(rule?.metric ?? "failed")
    setQueue(rule?.queue ?? undefined)
    setOperator(rule?.operator ?? "gt")
    setThreshold(String(rule?.threshold ?? 0))
    setEnabled(rule?.enabled ?? true)
    setSelectedChannels(new Set(rule?.channels ?? []))
  }, [isOpen, rule])

  const action = useCockpitAction({
    success: rule ? "Alert updated" : "Alert created",
    invalidate: [["alerts"], ["alertRules"]],
  })

  const isGlobal = metric === "stuck"
  const valid = name.trim().length > 0 && threshold !== ""

  const submit = () => {
    action.mutate(
      () =>
        api.saveAlertRule({
          id: rule?.id,
          name: name.trim(),
          metric,
          queue: isGlobal ? undefined : queue,
          operator,
          threshold: Number(threshold) || 0,
          enabled,
          channels: [...selectedChannels],
        }),
      { onSuccess: onClose },
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span>{rule ? "Edit alert" : "New alert"}</span>
          <span className="text-xs font-normal text-foreground-400">
            Fires when the condition holds; notifies the selected channels.
          </span>
        </ModalHeader>
        <ModalBody className="gap-4">
          <Input
            variant="bordered"
            label="Name"
            labelPlacement="outside"
            isRequired
            placeholder="Payments failing"
            value={name}
            onValueChange={setName}
          />

          <Select
            variant="bordered"
            label="Metric"
            labelPlacement="outside"
            selectedKeys={[metric]}
            onSelectionChange={(keys) => setMetric(String([...keys][0] ?? "failed") as AlertMetric)}
          >
            {METRICS.map(([value, label]) => (
              <SelectItem key={value}>{label}</SelectItem>
            ))}
          </Select>

          {!isGlobal && (
            <QueuePicker
              label="Queue"
              queues={queues}
              value={queue}
              onChange={setQueue}
              allowAll
              className="w-full"
            />
          )}

          <div className="grid grid-cols-2 gap-3">
            <Select
              variant="bordered"
              label="Condition"
              labelPlacement="outside"
              selectedKeys={[operator]}
              onSelectionChange={(keys) =>
                setOperator(String([...keys][0] ?? "gt") as AlertOperator)
              }
            >
              {OPERATORS.map(([value, label]) => (
                <SelectItem key={value}>{label}</SelectItem>
              ))}
            </Select>
            <Input
              variant="bordered"
              type="number"
              label="Threshold"
              labelPlacement="outside"
              value={threshold}
              onValueChange={setThreshold}
              min={0}
            />
          </div>

          <Select
            variant="bordered"
            label="Notify channels"
            labelPlacement="outside"
            selectionMode="multiple"
            placeholder={channels.length ? "None (dashboard only)" : "No channels yet"}
            isDisabled={channels.length === 0}
            selectedKeys={selectedChannels}
            onSelectionChange={(keys) => setSelectedChannels(new Set([...keys].map(String)))}
            description="A rule with no channels still shows on the dashboard — it just won't notify."
          >
            {channels.map((ch) => (
              <SelectItem key={ch.id}>{ch.name}</SelectItem>
            ))}
          </Select>

          <Switch isSelected={enabled} onValueChange={setEnabled} size="sm">
            <span className="text-[15px] text-foreground-600">Enabled</span>
          </Switch>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose} isDisabled={action.isPending}>
            Cancel
          </Button>
          <Button color="primary" onPress={submit} isLoading={action.isPending} isDisabled={!valid}>
            {rule ? "Save changes" : "Create alert"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
