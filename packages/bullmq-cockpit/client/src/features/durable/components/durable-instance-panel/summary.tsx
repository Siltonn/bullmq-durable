import { Card, CardBody, Chip, Divider, Tooltip } from "@heroui/react"
import type { ReactNode } from "react"
import type { DurableInstanceDetail } from "@shared/dto"
import { CopyButton } from "@/components/ui/copy-button"
import { RelativeTime, Countdown } from "@/components/ui/relative-time"
import { DurableStatusChip } from "@/components/ui/status-badge"
import { formatDuration } from "@/lib/format"
import { CockpitIcon } from "@/lib/icons"
import { STUCK_LABELS } from "@/lib/status"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-foreground-400">{label}</dt>
      <dd className="mt-1 text-[15px] text-foreground-700">{children}</dd>
    </div>
  )
}

export function InstanceHeader({
  instance,
  actions,
}: {
  instance: DurableInstanceDetail
  actions: ReactNode
}) {
  const progress = instance.stepCount > 0 ? instance.completedSteps / instance.stepCount : 0
  return (
    <Card shadow="none" className="glass-card">
      <CardBody className="gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <DurableStatusChip status={instance.derivedStatus} size="md" />
              {instance.stuck && (
                <Tooltip content={STUCK_LABELS[instance.stuck]} size="md">
                  <Chip
                    size="md"
                    variant="flat"
                    color="danger"
                    startContent={<CockpitIcon name="stuck" width={12} />}
                  >
                    stuck
                  </Chip>
                </Tooltip>
              )}
            </div>
            <div className="flex items-center gap-1">
              <span className="font-mono text-sm text-foreground">{instance.id}</span>
              <CopyButton value={instance.id} label="Copy instance id" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>

        <Divider />

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Queue">{instance.queueName}</Field>
          <Field label="Job">{instance.jobName}</Field>
          <Field label="Business id">{instance.businessId}</Field>
          <Field label="Runs">{instance.runCount}</Field>
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-foreground-400">Steps</dt>
            <dd className="mt-1.5 flex items-center gap-2">
              <div className="h-2 w-20 overflow-hidden rounded-full bg-default-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-secondary transition-[width] duration-500"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <span className="text-sm tabular-nums text-foreground-700">
                {instance.completedSteps}/{instance.stepCount}
              </span>
            </dd>
          </div>
          <Field label="Duration">{formatDuration(instance.durationMs)}</Field>
          <Field label="Updated">
            <RelativeTime value={instance.updatedAt} live />
          </Field>
          <Field label="Next resume">
            {instance.nextRunAt ? <Countdown target={instance.nextRunAt} /> : "—"}
          </Field>
        </dl>
      </CardBody>
    </Card>
  )
}
