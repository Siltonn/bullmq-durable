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
  Textarea,
} from "@heroui/react"
import { useState } from "react"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { CockpitIcon } from "@/lib/icons"

const DEFAULT_DATA = "{\n  \n}"

/** Manually enqueue a job onto a queue (works for plain and durable queues). */
export function AddJobModal({
  queue,
  isOpen,
  onClose,
}: {
  queue: string
  isOpen: boolean
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [dataText, setDataText] = useState(DEFAULT_DATA)
  const [delaySec, setDelaySec] = useState("")
  const [priority, setPriority] = useState("")
  const [attempts, setAttempts] = useState("")
  const [jobId, setJobId] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const action = useCockpitAction({
    success: "Job added",
    invalidate: [["jobs"], ["queues"], ["overview"], ["durable"]],
  })

  const reset = () => {
    setName("")
    setDataText(DEFAULT_DATA)
    setDelaySec("")
    setPriority("")
    setAttempts("")
    setJobId("")
    setJsonError(null)
  }

  const close = () => {
    reset()
    onClose()
  }

  const submit = () => {
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
    setJsonError(null)
    action.mutate(
      () =>
        api.addJob(queue, {
          name: name.trim(),
          data,
          delay: delaySec ? Number(delaySec) * 1000 : undefined,
          priority: priority ? Number(priority) : undefined,
          attempts: attempts ? Number(attempts) : undefined,
          jobId: jobId.trim() || undefined,
        }),
      { onSuccess: close },
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={close} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span>Add job</span>
          <span className="text-xs font-normal text-foreground-400">to queue “{queue}”</span>
        </ModalHeader>
        <ModalBody className="gap-4">
          <Input
            variant="bordered"
            label="Job name"
            labelPlacement="outside"
            placeholder="e.g. video"
            isRequired
            value={name}
            onValueChange={setName}
            startContent={<CockpitIcon name="jobs" width={16} className="text-foreground-400" />}
          />
          <Textarea
            variant="bordered"
            label="Data (JSON)"
            labelPlacement="outside"
            minRows={6}
            value={dataText}
            onValueChange={(v) => {
              setDataText(v)
              if (jsonError) setJsonError(null)
            }}
            isInvalid={Boolean(jsonError)}
            errorMessage={jsonError}
            classNames={{ input: "font-mono text-[13px] leading-relaxed" }}
          />
          <Accordion isCompact className="px-0">
            <AccordionItem
              key="advanced"
              aria-label="Advanced options"
              title={<span className="text-sm text-foreground-500">Advanced options</span>}
            >
              <div className="grid grid-cols-2 gap-3 pb-1">
                <Input
                  variant="bordered"
                  type="number"
                  label="Delay (seconds)"
                  labelPlacement="outside"
                  placeholder="0"
                  value={delaySec}
                  onValueChange={setDelaySec}
                  min={0}
                />
                <Input
                  variant="bordered"
                  type="number"
                  label="Priority"
                  labelPlacement="outside"
                  placeholder="0"
                  value={priority}
                  onValueChange={setPriority}
                  min={0}
                />
                <Input
                  variant="bordered"
                  type="number"
                  label="Attempts"
                  labelPlacement="outside"
                  placeholder="1"
                  value={attempts}
                  onValueChange={setAttempts}
                  min={1}
                />
                <Input
                  variant="bordered"
                  label="Job ID (optional)"
                  labelPlacement="outside"
                  placeholder="auto"
                  value={jobId}
                  onValueChange={setJobId}
                />
              </div>
            </AccordionItem>
          </Accordion>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close} isDisabled={action.isPending}>
            Cancel
          </Button>
          <Button
            color="primary"
            onPress={submit}
            isLoading={action.isPending}
            isDisabled={!name.trim()}
            startContent={!action.isPending ? <CockpitIcon name="play" width={15} /> : undefined}
          >
            Add job
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
