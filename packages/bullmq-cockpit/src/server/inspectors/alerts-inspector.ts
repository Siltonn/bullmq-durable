/**
 * AlertsInspector — the cockpit's own alerting layer.
 *
 * Unlike the other inspectors (which only read BullMQ / durable state), this one
 * owns a small amount of *cockpit* state: user-defined alert rules and the
 * notification channels they fire to, stored under the cockpit prefix. Rules are
 * evaluated live (a single `listQueues`) for the dashboard; a background
 * scheduler re-evaluates on an interval and POSTs to channels when a rule
 * transitions from ok → firing (and again, once, when it resolves).
 */

import { randomUUID } from "node:crypto"
import type { Redis } from "ioredis"
import type {
  AlertChannel,
  AlertEvaluation,
  AlertMetric,
  AlertOffender,
  AlertOperator,
  AlertRule,
  AlertsOverview,
  QueueSummary,
} from "../../shared/dto"
import type { BullMQInspector } from "./bullmq"
import type { HealthInspector } from "./health-inspector"

interface RuleState {
  firing: boolean
  since?: number
  lastNotified?: number
}

export interface AlertRuleInput {
  id?: string
  name: string
  metric: AlertMetric
  queue?: string
  operator: AlertOperator
  threshold: number
  enabled: boolean
  channels: string[]
}

export interface AlertChannelInput {
  id?: string
  name: string
  type: "webhook" | "slack"
  url: string
}

export interface AlertsInspectorDeps {
  redis: Redis
  prefix: string
  bullmq: BullMQInspector
  health: HealthInspector
  durableEnabled: boolean
}

export class AlertsInspector {
  private readonly redis: Redis
  private readonly rulesKey: string
  private readonly channelsKey: string
  private readonly stateKey: string
  private readonly bullmq: BullMQInspector
  private readonly health: HealthInspector
  private readonly durableEnabled: boolean

  constructor(deps: AlertsInspectorDeps) {
    this.redis = deps.redis
    this.rulesKey = `${deps.prefix}:alert:rules`
    this.channelsKey = `${deps.prefix}:alert:channels`
    this.stateKey = `${deps.prefix}:alert:state`
    this.bullmq = deps.bullmq
    this.health = deps.health
    this.durableEnabled = deps.durableEnabled
  }

  // -- Rules ---------------------------------------------------------------

  async listRules(): Promise<AlertRule[]> {
    const hash = await this.redis.hgetall(this.rulesKey)
    return Object.values(hash)
      .map((raw) => safeParse<AlertRule>(raw))
      .filter((r): r is AlertRule => r !== null)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async getRule(id: string): Promise<AlertRule | null> {
    const raw = await this.redis.hget(this.rulesKey, id)
    return raw ? safeParse<AlertRule>(raw) : null
  }

  async saveRule(input: AlertRuleInput): Promise<AlertRule> {
    const id = input.id ?? randomUUID()
    const existing = input.id ? await this.getRule(input.id) : null
    const rule: AlertRule = {
      id,
      name: input.name,
      metric: input.metric,
      queue: input.queue && input.queue !== "*" ? input.queue : undefined,
      operator: input.operator,
      threshold: input.threshold,
      enabled: input.enabled,
      channels: input.channels,
      createdAt: existing?.createdAt ?? Date.now(),
    }
    await this.redis.hset(this.rulesKey, id, JSON.stringify(rule))
    return rule
  }

  async removeRule(id: string): Promise<void> {
    await this.redis.hdel(this.rulesKey, id)
    await this.redis.hdel(this.stateKey, id)
  }

  async toggleRule(id: string): Promise<void> {
    const rule = await this.getRule(id)
    if (!rule) return
    rule.enabled = !rule.enabled
    await this.redis.hset(this.rulesKey, id, JSON.stringify(rule))
  }

  // -- Channels ------------------------------------------------------------

  async listChannels(): Promise<AlertChannel[]> {
    const hash = await this.redis.hgetall(this.channelsKey)
    return Object.values(hash)
      .map((raw) => safeParse<AlertChannel>(raw))
      .filter((c): c is AlertChannel => c !== null)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async saveChannel(input: AlertChannelInput): Promise<AlertChannel> {
    const id = input.id ?? randomUUID()
    const existingRaw = input.id ? await this.redis.hget(this.channelsKey, input.id) : null
    const prev = existingRaw ? safeParse<AlertChannel>(existingRaw) : null
    const channel: AlertChannel = {
      id,
      name: input.name,
      type: input.type,
      url: input.url,
      createdAt: prev?.createdAt ?? Date.now(),
    }
    await this.redis.hset(this.channelsKey, id, JSON.stringify(channel))
    return channel
  }

  async removeChannel(id: string): Promise<void> {
    await this.redis.hdel(this.channelsKey, id)
  }

  /** Send a one-off test notification to a channel; returns whether it 2xx'd. */
  async testChannel(id: string): Promise<boolean> {
    const raw = await this.redis.hget(this.channelsKey, id)
    const channel = raw ? safeParse<AlertChannel>(raw) : null
    if (!channel) return false
    return this.post(channel, this.testPayload(channel))
  }

  // -- Evaluation ----------------------------------------------------------

  async overview(): Promise<AlertsOverview> {
    const [evaluations, channels] = await Promise.all([this.evaluate(), this.listChannels()])
    return {
      evaluations,
      firing: evaluations.filter((e) => e.firing).length,
      total: evaluations.length,
      channels: channels.length,
    }
  }

  async evaluate(): Promise<AlertEvaluation[]> {
    const rules = await this.listRules()
    if (rules.length === 0) return []
    const queues = await this.bullmq.listQueues().catch(() => [] as QueueSummary[])
    const needStuck = this.durableEnabled && rules.some((r) => r.enabled && r.metric === "stuck")
    let stuckCount = 0
    if (needStuck) {
      const report = await this.health.stuck().catch(() => null)
      stuckCount = report?.stuck.length ?? 0
    }
    const states = await this.loadStates()
    const now = Date.now()
    return rules.map((rule) =>
      this.evaluateRule(rule, queues, stuckCount, states.get(rule.id), now),
    )
  }

  private evaluateRule(
    rule: AlertRule,
    queues: QueueSummary[],
    stuckCount: number,
    state: RuleState | undefined,
    now: number,
  ): AlertEvaluation {
    if (!rule.enabled) {
      return { rule, firing: false, value: 0, offenders: [], observedAt: now }
    }
    if (rule.metric === "stuck") {
      const firing = compare(stuckCount, rule.operator, rule.threshold)
      return {
        rule,
        firing,
        value: stuckCount,
        offenders: [],
        since: firing ? state?.since : undefined,
        observedAt: now,
      }
    }
    const targets =
      rule.queue && rule.queue !== "*" ? queues.filter((q) => q.name === rule.queue) : queues
    const offenders: AlertOffender[] = []
    let worst = 0
    for (const q of targets) {
      const value = metricValue(rule.metric, q)
      if (value > worst) worst = value
      if (compare(value, rule.operator, rule.threshold)) offenders.push({ queue: q.name, value })
    }
    const firing = offenders.length > 0
    return {
      rule,
      firing,
      value: firing ? Math.max(...offenders.map((o) => o.value)) : worst,
      offenders,
      since: firing ? state?.since : undefined,
      observedAt: now,
    }
  }

  // -- Notifier tick -------------------------------------------------------

  /** Evaluate every rule and dispatch to channels on ok→firing transitions. */
  async tick(): Promise<void> {
    const [evaluations, channels] = await Promise.all([this.evaluate(), this.listChannels()])
    const byId = new Map(channels.map((c) => [c.id, c]))
    const states = await this.loadStates()
    const now = Date.now()
    for (const ev of evaluations) {
      const prev = states.get(ev.rule.id)
      const wasFiring = prev?.firing ?? false
      if (ev.firing && !wasFiring) {
        await this.notify(ev, byId, "firing")
        await this.saveState(ev.rule.id, { firing: true, since: now, lastNotified: now })
      } else if (ev.firing) {
        await this.saveState(ev.rule.id, {
          firing: true,
          since: prev?.since ?? now,
          lastNotified: prev?.lastNotified,
        })
      } else if (wasFiring) {
        await this.notify(ev, byId, "resolved")
        await this.saveState(ev.rule.id, { firing: false })
      }
    }
  }

  private async notify(
    ev: AlertEvaluation,
    channels: Map<string, AlertChannel>,
    kind: "firing" | "resolved",
  ): Promise<void> {
    await Promise.all(
      ev.rule.channels.map((id) => {
        const channel = channels.get(id)
        return channel
          ? this.post(channel, this.payload(channel, ev, kind))
          : Promise.resolve(false)
      }),
    )
  }

  // -- State + dispatch helpers -------------------------------------------

  private async loadStates(): Promise<Map<string, RuleState>> {
    const hash = await this.redis.hgetall(this.stateKey)
    const map = new Map<string, RuleState>()
    for (const [id, raw] of Object.entries(hash)) {
      const parsed = safeParse<RuleState>(raw)
      if (parsed) map.set(id, parsed)
    }
    return map
  }

  private async saveState(id: string, state: RuleState): Promise<void> {
    await this.redis.hset(this.stateKey, id, JSON.stringify(state))
  }

  private payload(channel: AlertChannel, ev: AlertEvaluation, kind: "firing" | "resolved") {
    const where =
      ev.offenders.length > 0
        ? ` on ${ev.offenders.map((o) => `${o.queue} (${o.value})`).join(", ")}`
        : ""
    const text =
      kind === "firing"
        ? `🚨 *${ev.rule.name}* is firing — ${describeRule(ev.rule)}; observed ${ev.value}${where}`
        : `✅ *${ev.rule.name}* resolved`
    if (channel.type === "slack") return { text }
    return {
      type: kind === "firing" ? "alert.firing" : "alert.resolved",
      rule: ev.rule,
      value: ev.value,
      offenders: ev.offenders,
      message: text,
      at: ev.observedAt,
    }
  }

  private testPayload(channel: AlertChannel) {
    const text = "🔔 bullmq-cockpit test notification — this channel is wired up correctly."
    return channel.type === "slack"
      ? { text }
      : { type: "alert.test", message: text, at: Date.now() }
  }

  private async post(channel: AlertChannel, body: unknown): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(channel.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)
      return res.ok
    } catch (err) {
      console.error(`[bullmq-cockpit] alert channel "${channel.name}" failed:`, err)
      return false
    }
  }
}

// --- helpers ---------------------------------------------------------------

function metricValue(metric: AlertMetric, q: QueueSummary): number {
  const c = q.counts
  switch (metric) {
    case "failed":
      return c.failed
    case "waiting":
      return c.waiting
    case "active":
      return c.active
    case "backlog":
      return c.waiting + c.delayed + c["waiting-children"]
    case "no_workers": {
      const pending = c.waiting + c.active + c.delayed + c["waiting-children"]
      return q.workers === 0 ? pending : 0
    }
    default:
      return 0
  }
}

function compare(value: number, op: AlertOperator, threshold: number): boolean {
  switch (op) {
    case "gt":
      return value > threshold
    case "gte":
      return value >= threshold
    case "lt":
      return value < threshold
    case "lte":
      return value <= threshold
  }
}

const OP_TEXT: Record<AlertOperator, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" }

function describeRule(rule: AlertRule): string {
  if (rule.metric === "stuck") return `stuck instances ${OP_TEXT[rule.operator]} ${rule.threshold}`
  const scope = rule.queue && rule.queue !== "*" ? rule.queue : "any queue"
  return `${rule.metric} ${OP_TEXT[rule.operator]} ${rule.threshold} on ${scope}`
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// --- background scheduler --------------------------------------------------

export interface AlertScheduler {
  stop: () => void
}

/** Start a setInterval loop driving {@link AlertsInspector.tick}. */
export function startAlertScheduler(alerts: AlertsInspector, intervalMs: number): AlertScheduler {
  let running = false
  const run = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await alerts.tick()
    } catch (err) {
      console.error("[bullmq-cockpit] alert tick failed:", err)
    } finally {
      running = false
    }
  }
  const timer = setInterval(run, intervalMs)
  if (typeof timer.unref === "function") timer.unref()
  // Kick once shortly after start so initial firing state is populated.
  const initial = setTimeout(run, 2000)
  if (typeof initial.unref === "function") initial.unref()
  return {
    stop: () => {
      clearInterval(timer)
      clearTimeout(initial)
    },
  }
}
