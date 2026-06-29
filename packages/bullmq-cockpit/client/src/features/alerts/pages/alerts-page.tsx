import { Button, Card, CardBody, Chip, Switch } from "@heroui/react"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { ALERT_METRIC_LABELS, type AlertEvaluation, type AlertRule } from "@shared/dto"
import { ActionMenu, type ActionItem } from "@/components/ui/action-menu"
import { MetricCard } from "@/components/ui/metric-card"
import { PageHeader } from "@/components/ui/page-header"
import { RelativeTime } from "@/components/ui/relative-time"
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states"
import { api } from "@/lib/api"
import { useCockpitAction } from "@/lib/providers/actions"
import { usePermission } from "@/lib/providers/config"
import { useConfirm } from "@/lib/providers/confirm"
import { CockpitIcon } from "@/lib/icons"
import { AlertRuleModal } from "@/features/alerts/components/alert-rule-modal"
import { ChannelsModal } from "@/features/alerts/components/channels-modal"
import { OP_SYMBOL } from "@/features/alerts/config/constants"

function conditionText(rule: AlertRule): string {
  const scope =
    rule.metric === "stuck" ? "global" : rule.queue && rule.queue !== "*" ? rule.queue : "any queue"
  return `${ALERT_METRIC_LABELS[rule.metric]} ${OP_SYMBOL[rule.operator]} ${rule.threshold} · ${scope}`
}

function RuleRow({
  ev,
  canWrite,
  onEdit,
  onToggle,
  onRemove,
}: {
  ev: AlertEvaluation
  canWrite: boolean
  onEdit: () => void
  onToggle: () => void
  onRemove: () => void
}) {
  const { rule } = ev
  const status = !rule.enabled ? "disabled" : ev.firing ? "firing" : "ok"
  const items: ActionItem[] = [
    { key: "edit", label: "Edit", icon: "edit", hidden: !canWrite, onAction: onEdit },
    {
      key: "remove",
      label: "Remove",
      icon: "remove",
      color: "danger",
      hidden: !canWrite,
      onAction: onRemove,
    },
  ]

  return (
    <Card shadow="none" className={`glass-card ${status === "firing" ? "border-danger/40" : ""}`}>
      <CardBody className="flex-row items-center gap-4 py-3.5">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-medium ${
            status === "firing"
              ? "bg-danger/10 text-danger"
              : status === "ok"
                ? "bg-success/10 text-success"
                : "bg-default-100 text-foreground-400"
          }`}
        >
          <CockpitIcon name={status === "firing" ? "alert" : "alerts"} width={18} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-foreground">{rule.name}</span>
            {status === "firing" && (
              <Chip size="sm" color="danger" variant="flat">
                Firing
              </Chip>
            )}
            {status === "ok" && (
              <Chip size="sm" color="success" variant="flat">
                OK
              </Chip>
            )}
            {status === "disabled" && (
              <Chip size="sm" variant="flat">
                Disabled
              </Chip>
            )}
          </div>
          <p className="truncate text-[13px] text-foreground-400">{conditionText(rule)}</p>
          {ev.firing && ev.offenders.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {ev.offenders.slice(0, 6).map((o) => (
                <Chip key={o.queue} size="sm" variant="flat" color="danger" className="h-5">
                  {o.queue}: {o.value}
                </Chip>
              ))}
            </div>
          )}
        </div>

        <div className="hidden shrink-0 flex-col items-end sm:flex">
          <span
            className={`text-lg font-semibold tabular-nums ${ev.firing ? "text-danger" : "text-foreground-600"}`}
          >
            {ev.value}
          </span>
          {ev.firing && ev.since ? (
            <span className="text-xs text-foreground-400">
              since <RelativeTime value={ev.since} />
            </span>
          ) : (
            <span className="text-xs text-foreground-300">observed</span>
          )}
        </div>

        {canWrite && (
          <>
            <Switch
              size="sm"
              isSelected={rule.enabled}
              onValueChange={onToggle}
              aria-label="Toggle rule"
            />
            <ActionMenu items={items} />
          </>
        )}
      </CardBody>
    </Card>
  )
}

export function AlertsPage() {
  const can = usePermission()
  const canWrite = can("queue:write")
  const confirm = useConfirm()
  const [ruleModal, setRuleModal] = useState<{ open: boolean; rule: AlertRule | null }>({
    open: false,
    rule: null,
  })
  const [channelsOpen, setChannelsOpen] = useState(false)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["alerts"],
    queryFn: api.alerts,
    refetchInterval: 5000,
  })
  const { data: queues } = useQuery({ queryKey: ["queues"], queryFn: api.queues })
  const { data: channels } = useQuery({ queryKey: ["alertChannels"], queryFn: api.alertChannels })

  const toggle = useCockpitAction({
    success: "Alert updated",
    invalidate: [["alerts"], ["alertRules"]],
  })
  const remove = useCockpitAction({
    success: "Alert removed",
    invalidate: [["alerts"], ["alertRules"]],
  })

  const onRemove = async (rule: AlertRule) => {
    if (
      await confirm({
        title: "Remove alert?",
        body: `Delete the alert "${rule.name}". This cannot be undone.`,
        confirmLabel: "Remove",
        confirmColor: "danger",
      })
    )
      remove.mutate(() => api.removeAlertRule(rule.id))
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Alerts"
        description="Live rules over queue & durable health, with channel notifications"
        icon="alerts"
        actions={
          canWrite && (
            <div className="flex items-center gap-2.5">
              <Button
                variant="flat"
                startContent={<CockpitIcon name="bell" width={17} />}
                onPress={() => setChannelsOpen(true)}
              >
                Channels{channels && channels.length > 0 ? ` (${channels.length})` : ""}
              </Button>
              <Button
                color="primary"
                startContent={<CockpitIcon name="add" width={17} />}
                onPress={() => setRuleModal({ open: true, rule: null })}
              >
                New alert
              </Button>
            </div>
          )
        }
      />

      {data && data.total > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <MetricCard
            label="Firing"
            value={data.firing}
            icon="alert"
            color={data.firing > 0 ? "danger" : "success"}
          />
          <MetricCard label="Rules" value={data.total} icon="alerts" />
          <MetricCard label="Channels" value={data.channels} icon="bell" color="secondary" />
        </div>
      )}

      {isLoading ? (
        <LoadingState label="Evaluating alerts…" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !data || data.evaluations.length === 0 ? (
        <EmptyState
          icon="alerts"
          title="No alerts yet"
          description="Create a rule to watch failures, backlog, missing workers, or stuck durable instances — and get notified on Slack or a webhook."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {[...data.evaluations]
            .sort((a, b) => Number(b.firing) - Number(a.firing))
            .map((ev) => (
              <RuleRow
                key={ev.rule.id}
                ev={ev}
                canWrite={canWrite}
                onEdit={() => setRuleModal({ open: true, rule: ev.rule })}
                onToggle={() => toggle.mutate(() => api.toggleAlertRule(ev.rule.id))}
                onRemove={() => void onRemove(ev.rule)}
              />
            ))}
        </div>
      )}

      <AlertRuleModal
        rule={ruleModal.rule}
        queues={queues ?? []}
        channels={channels ?? []}
        isOpen={ruleModal.open}
        onClose={() => setRuleModal({ open: false, rule: null })}
      />
      <ChannelsModal
        channels={channels ?? []}
        isOpen={channelsOpen}
        onClose={() => setChannelsOpen(false)}
      />
    </div>
  )
}
