import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react"
import type { ReactNode } from "react"

export interface ConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  body?: ReactNode
  confirmLabel?: string
  confirmColor?: "primary" | "danger" | "warning"
  isLoading?: boolean
}

/** A controlled confirmation modal for destructive / mutating actions. */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  confirmColor = "primary",
  isLoading = false,
}: ConfirmDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" placement="center">
      <ModalContent>
        <ModalHeader>{title}</ModalHeader>
        <ModalBody>
          {typeof body === "string" ? <p className="text-sm text-foreground-600">{body}</p> : body}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose} isDisabled={isLoading}>
            Cancel
          </Button>
          <Button color={confirmColor} onPress={onConfirm} isLoading={isLoading}>
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
