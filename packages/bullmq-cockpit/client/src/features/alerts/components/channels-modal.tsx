import {
  Button,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
} from "@heroui/react"
import { useState } from "react"
import type { AlertChannel, AlertChannelType } from "@shared/dto"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { CockpitIcon } from "@/lib/icons"
import { useToast } from "@/lib/providers/toast"

export function ChannelsModal({
  channels,
  isOpen,
  onClose,
}: {
  channels: AlertChannel[]
  isOpen: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState("")
  const [type, setType] = useState<AlertChannelType>("slack")
  const [url, setUrl] = useState("")
  const [testing, setTesting] = useState<string | null>(null)

  const save = useCockpitAction({
    success: "Channel added",
    invalidate: [["alertChannels"], ["alerts"]],
  })
  const remove = useCockpitAction({
    success: "Channel removed",
    invalidate: [["alertChannels"], ["alerts"]],
  })

  const validUrl = /^https?:\/\//.test(url.trim())
  const canAdd = name.trim().length > 0 && validUrl

  const add = () => {
    save.mutate(() => api.saveAlertChannel({ name: name.trim(), type, url: url.trim() }), {
      onSuccess: () => {
        setName("")
        setUrl("")
      },
    })
  }

  const test = async (id: string) => {
    setTesting(id)
    try {
      const res = await api.testAlertChannel(id)
      toast({
        message: res.message ?? (res.ok ? "Sent" : "Failed"),
        type: res.ok ? "success" : "error",
      })
    } catch {
      toast({ message: "Test failed", type: "error" })
    } finally {
      setTesting(null)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span>Notification channels</span>
          <span className="text-xs font-normal text-foreground-400">
            Slack incoming webhooks or any HTTP endpoint that accepts a JSON POST.
          </span>
        </ModalHeader>
        <ModalBody className="gap-4">
          {channels.length > 0 && (
            <ul className="flex flex-col gap-2">
              {channels.map((ch) => (
                <li
                  key={ch.id}
                  className="flex items-center gap-3 rounded-medium border border-default-200 px-3 py-2.5"
                >
                  <CockpitIcon
                    name={ch.type === "slack" ? "alerts" : "webhook"}
                    width={18}
                    className="shrink-0 text-foreground-400"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{ch.name}</span>
                      <Chip size="sm" variant="flat">
                        {ch.type}
                      </Chip>
                    </div>
                    <p className="truncate font-mono text-xs text-foreground-400">{ch.url}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="flat"
                    startContent={<CockpitIcon name="send" width={14} />}
                    isLoading={testing === ch.id}
                    onPress={() => void test(ch.id)}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    isIconOnly
                    variant="light"
                    color="danger"
                    aria-label="Remove channel"
                    onPress={() => remove.mutate(() => api.removeAlertChannel(ch.id))}
                  >
                    <CockpitIcon name="remove" width={16} />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-large border border-dashed border-default-300 p-4">
            <p className="mb-3 text-sm font-medium text-foreground-600">Add a channel</p>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-3">
                <Input
                  variant="bordered"
                  label="Name"
                  labelPlacement="outside"
                  placeholder="Ops Slack"
                  value={name}
                  onValueChange={setName}
                  className="col-span-2"
                />
                <Select
                  variant="bordered"
                  label="Type"
                  labelPlacement="outside"
                  selectedKeys={[type]}
                  onSelectionChange={(keys) =>
                    setType(String([...keys][0] ?? "slack") as AlertChannelType)
                  }
                >
                  <SelectItem key="slack">Slack</SelectItem>
                  <SelectItem key="webhook">Webhook</SelectItem>
                </Select>
              </div>
              <Input
                variant="bordered"
                label="Webhook URL"
                labelPlacement="outside"
                placeholder="https://hooks.slack.com/services/…"
                value={url}
                onValueChange={setUrl}
                isInvalid={url.length > 0 && !validUrl}
                errorMessage={url.length > 0 && !validUrl ? "Must be an http(s) URL" : undefined}
                classNames={{ input: "font-mono text-[13px]" }}
              />
              <div className="flex justify-end">
                <Button
                  color="primary"
                  startContent={<CockpitIcon name="add" width={16} />}
                  isLoading={save.isPending}
                  isDisabled={!canAdd}
                  onPress={add}
                >
                  Add channel
                </Button>
              </div>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Done
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
