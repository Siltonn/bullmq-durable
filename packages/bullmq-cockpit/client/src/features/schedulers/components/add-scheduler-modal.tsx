import {
  Accordion,
  AccordionItem,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tab,
  Tabs,
  Textarea,
} from "@heroui/react"
import { useState } from "react"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { QueuePicker } from "@/components/ui/queue-picker"
import { CockpitIcon } from "@/lib/icons"

const DEFAULT_DATA = "{\n  \n}"

export function AddSchedulerModal({
  queues,
  isOpen,
  onClose,
}: {
  queues: { name: string }[]
  isOpen: boolean
  onClose: () => void
}) {
  const [queue, setQueue] = useState<string | undefined>(queues[0]?.name)
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [mode, setMode] = useState<"cron" | "interval">("cron")
  const [pattern, setPattern] = useState("")
  const [everySec, setEverySec] = useState("")
  const [tz, setTz] = useState("")
  const [dataText, setDataText] = useState(DEFAULT_DATA)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const action = useCockpitAction({ success: "Scheduler created", invalidate: [["schedulers"]] })

  const close = () => {
    setId("")
    setName("")
    setMode("cron")
    setPattern("")
    setEverySec("")
    setTz("")
    setDataText(DEFAULT_DATA)
    setJsonError(null)
    onClose()
  }

  const valid =
    Boolean(queue) &&
    Boolean(id.trim()) &&
    (mode === "cron" ? Boolean(pattern.trim()) : Boolean(everySec))

  const submit = () => {
    if (!queue) return
    let data: unknown = {}
    const trimmed = dataText.trim()
    if (trimmed) {
      try {
        data = JSON.parse(trimmed)
      } catch (err) {
        setJsonError(`Invalid JSON: ${err instanceof Error ? err.message : "parse error"}`)
        return
      }
    }
    action.mutate(
      () =>
        api.addScheduler(queue, {
          id: id.trim(),
          name: name.trim() || undefined,
          pattern: mode === "cron" ? pattern.trim() : undefined,
          every: mode === "interval" ? Number(everySec) * 1000 : undefined,
          tz: tz.trim() || undefined,
          data,
        }),
      { onSuccess: close },
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={close} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span>New scheduler</span>
          <span className="text-xs font-normal text-foreground-400">
            Enqueue a job on a cron pattern or fixed interval
          </span>
        </ModalHeader>
        <ModalBody className="gap-4">
          <QueuePicker
            queues={queues}
            value={queue}
            onChange={setQueue}
            label="Queue"
            className="w-full"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              variant="bordered"
              label="Scheduler id"
              labelPlacement="outside"
              isRequired
              placeholder="daily-report"
              value={id}
              onValueChange={setId}
            />
            <Input
              variant="bordered"
              label="Job name (optional)"
              labelPlacement="outside"
              placeholder="defaults to id"
              value={name}
              onValueChange={setName}
            />
          </div>

          <Tabs
            selectedKey={mode}
            onSelectionChange={(k) => setMode(k as "cron" | "interval")}
            variant="bordered"
            size="sm"
            aria-label="Schedule type"
          >
            <Tab
              key="cron"
              title={
                <span className="flex items-center gap-1.5">
                  <CockpitIcon name="schedulers" width={14} />
                  Cron pattern
                </span>
              }
            >
              <Input
                variant="bordered"
                label="Cron pattern"
                labelPlacement="outside"
                className="mt-2"
                placeholder="0 9 * * *"
                value={pattern}
                onValueChange={setPattern}
                classNames={{ input: "font-mono" }}
                description="Standard 5-field cron (min hour day month weekday)."
              />
            </Tab>
            <Tab
              key="interval"
              title={
                <span className="flex items-center gap-1.5">
                  <CockpitIcon name="timer" width={14} />
                  Interval
                </span>
              }
            >
              <Input
                variant="bordered"
                type="number"
                label="Every (seconds)"
                labelPlacement="outside"
                className="mt-2"
                placeholder="60"
                value={everySec}
                onValueChange={setEverySec}
                min={1}
              />
            </Tab>
          </Tabs>

          <Accordion isCompact className="px-0">
            <AccordionItem
              key="advanced"
              aria-label="Advanced"
              title={<span className="text-sm text-foreground-500">Advanced options</span>}
            >
              <div className="flex flex-col gap-3 pb-1">
                <Input
                  variant="bordered"
                  label="Timezone (optional)"
                  labelPlacement="outside"
                  placeholder="UTC"
                  value={tz}
                  onValueChange={setTz}
                />
                <Textarea
                  variant="bordered"
                  label="Data (JSON)"
                  labelPlacement="outside"
                  minRows={4}
                  value={dataText}
                  onValueChange={(v) => {
                    setDataText(v)
                    if (jsonError) setJsonError(null)
                  }}
                  isInvalid={Boolean(jsonError)}
                  errorMessage={jsonError}
                  classNames={{ input: "font-mono text-[13px]" }}
                />
              </div>
            </AccordionItem>
          </Accordion>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close} isDisabled={action.isPending}>
            Cancel
          </Button>
          <Button color="primary" onPress={submit} isLoading={action.isPending} isDisabled={!valid}>
            Create scheduler
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
