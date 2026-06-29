/**
 * The typed API client.
 *
 * One tiny `request` helper does the fetch + error handling; everything else is
 * a thin, fully-typed wrapper returning the shared wire DTOs. Errors become
 * {@link ApiError} so React Query and the UI can branch on status/code.
 */

import type {
  ActionResult,
  AlertChannel,
  AlertMetric,
  AlertOperator,
  AlertRule,
  AlertsOverview,
  DurableEvent,
  DurableInstanceDetail,
  DurableInstanceList,
  DurableLogEntry,
  DurableStep,
  FlowSummary,
  Health,
  JobDependencies,
  JobDetail,
  JobFlow,
  JobLogs,
  JobSummary,
  OverviewStats,
  Paginated,
  QueueActivity,
  QueueDetail,
  QueueMetrics,
  QueueSummary,
  RedisInfo,
  SchedulerSummary,
  CockpitConfig,
  StuckReport,
  SystemSignals,
} from "@shared/dto"
import { apiBase } from "@/lib/base-path"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** Build a query string from an object, dropping empty values. */
function qs(params: object): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    search.set(key, String(value))
  }
  const str = search.toString()
  return str ? `?${str}` : ""
}

const enc = encodeURIComponent

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  })

  if (!res.ok) {
    let code = "error"
    let message = res.statusText
    try {
      const payload = (await res.json()) as { error?: string; message?: string }
      code = payload.error ?? code
      message = payload.message ?? message
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new ApiError(res.status, code, message)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const get = <T>(path: string): Promise<T> => request<T>("GET", path)
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body)

export interface JobsQuery {
  status?: string
  jobName?: string
  search?: string
  page?: number
  pageSize?: number
}

export interface DurableQuery {
  status?: string
  queue?: string
  jobName?: string
  search?: string
  stuckOnly?: boolean
  sort?: string
  order?: string
  page?: number
  pageSize?: number
}

export interface CleanBody {
  graceMs?: number
  limit?: number
  status?: string
}

export interface AddJobBody {
  name: string
  data?: unknown
  delay?: number
  priority?: number
  attempts?: number
  jobId?: string
}

export interface AddSchedulerBody {
  id: string
  name?: string
  pattern?: string
  every?: number
  tz?: string
  limit?: number
  data?: unknown
}

export interface AlertRuleBody {
  id?: string
  name: string
  metric: AlertMetric
  queue?: string
  operator: AlertOperator
  threshold: number
  enabled: boolean
  channels: string[]
}

export interface AlertChannelBody {
  id?: string
  name: string
  type: "webhook" | "slack"
  url: string
}

export const api = {
  config: () => get<CockpitConfig>("/config"),

  // Overview
  overview: () => get<OverviewStats>("/overview"),
  signals: (windowMinutes?: number) =>
    get<SystemSignals>(`/overview/signals${qs({ windowMinutes })}`),

  // Activity (derived golden-signals: throughput + latency + job names)
  queueActivity: (queue: string, windowMinutes?: number) =>
    get<QueueActivity>(`/queues/${enc(queue)}/activity${qs({ windowMinutes })}`),

  // Queues
  queues: () => get<QueueSummary[]>("/queues"),
  queue: (name: string) => get<QueueDetail>(`/queues/${enc(name)}`),
  pauseQueue: (name: string) => post<ActionResult>(`/queues/${enc(name)}/pause`),
  resumeQueue: (name: string) => post<ActionResult>(`/queues/${enc(name)}/resume`),
  drainQueue: (name: string) => post<ActionResult>(`/queues/${enc(name)}/drain`),
  cleanQueue: (name: string, body: CleanBody) =>
    post<ActionResult>(`/queues/${enc(name)}/clean`, body),

  // Jobs
  jobs: (queue: string, query: JobsQuery) =>
    get<Paginated<JobSummary>>(`/queues/${enc(queue)}/jobs${qs(query)}`),
  addJob: (queue: string, body: AddJobBody) =>
    post<ActionResult>(`/queues/${enc(queue)}/jobs`, body),
  job: (queue: string, jobId: string) => get<JobDetail>(`/queues/${enc(queue)}/jobs/${enc(jobId)}`),
  jobLogs: (queue: string, jobId: string) =>
    get<JobLogs>(`/queues/${enc(queue)}/jobs/${enc(jobId)}/logs`),
  jobDependencies: (queue: string, jobId: string) =>
    get<JobDependencies>(`/queues/${enc(queue)}/jobs/${enc(jobId)}/dependencies`),
  jobFlow: (queue: string, jobId: string) =>
    get<JobFlow>(`/queues/${enc(queue)}/jobs/${enc(jobId)}/flow`),
  retryJob: (queue: string, jobId: string) =>
    post<ActionResult>(`/queues/${enc(queue)}/jobs/${enc(jobId)}/retry`),
  promoteJob: (queue: string, jobId: string) =>
    post<ActionResult>(`/queues/${enc(queue)}/jobs/${enc(jobId)}/promote`),
  removeJob: (queue: string, jobId: string) =>
    post<ActionResult>(`/queues/${enc(queue)}/jobs/${enc(jobId)}/remove`),
  duplicateJob: (queue: string, jobId: string) =>
    post<ActionResult>(`/queues/${enc(queue)}/jobs/${enc(jobId)}/duplicate`),
  bulkRetry: (queue: string, ids: string[]) =>
    post<ActionResult>(`/queues/${enc(queue)}/bulk/retry`, { ids }),
  bulkRemove: (queue: string, ids: string[]) =>
    post<ActionResult>(`/queues/${enc(queue)}/bulk/remove`, { ids }),

  // Schedulers
  schedulers: () => get<SchedulerSummary[]>("/schedulers"),
  queueSchedulers: (queue: string) => get<SchedulerSummary[]>(`/schedulers/${enc(queue)}`),
  addScheduler: (queue: string, body: AddSchedulerBody) =>
    post<ActionResult>(`/schedulers/${enc(queue)}`, body),
  removeScheduler: (queue: string, id: string) =>
    post<ActionResult>(`/schedulers/${enc(queue)}/${enc(id)}/remove`),

  // Flows
  flows: () => get<FlowSummary[]>("/flows"),

  // Alerts
  alerts: () => get<AlertsOverview>("/alerts"),
  alertRules: () => get<AlertRule[]>("/alerts/rules"),
  saveAlertRule: (body: AlertRuleBody) => post<ActionResult>("/alerts/rules", body),
  removeAlertRule: (id: string) => post<ActionResult>(`/alerts/rules/${enc(id)}/remove`),
  toggleAlertRule: (id: string) => post<ActionResult>(`/alerts/rules/${enc(id)}/toggle`),
  alertChannels: () => get<AlertChannel[]>("/alerts/channels"),
  saveAlertChannel: (body: AlertChannelBody) => post<ActionResult>("/alerts/channels", body),
  removeAlertChannel: (id: string) => post<ActionResult>(`/alerts/channels/${enc(id)}/remove`),
  testAlertChannel: (id: string) => post<ActionResult>(`/alerts/channels/${enc(id)}/test`),

  // Metrics + Redis
  metrics: (queue: string) => get<QueueMetrics>(`/queues/${enc(queue)}/metrics`),
  redisInfo: () => get<RedisInfo>("/health/redis"),

  // Durable
  durableInstances: (query: DurableQuery) =>
    get<DurableInstanceList>(`/durable/instances${qs(query)}`),
  durableInstance: (id: string) => get<DurableInstanceDetail>(`/durable/instances/${enc(id)}`),
  durableSteps: (id: string) => get<DurableStep[]>(`/durable/instances/${enc(id)}/steps`),
  durableEvents: (id: string) => get<DurableEvent[]>(`/durable/instances/${enc(id)}/events`),
  durableLogs: (id: string) => get<DurableLogEntry[]>(`/durable/instances/${enc(id)}/logs`),
  durableResume: (id: string) => post<ActionResult>(`/durable/instances/${enc(id)}/resume`),
  durableRetry: (id: string) => post<ActionResult>(`/durable/instances/${enc(id)}/retry`),
  durableCancel: (id: string) => post<ActionResult>(`/durable/instances/${enc(id)}/cancel`),
  durableDelete: (id: string) => post<ActionResult>(`/durable/instances/${enc(id)}/delete`),

  // Health
  health: () => get<Health>("/health"),
  stuck: (thresholdMs?: number) => get<StuckReport>(`/health/stuck${qs({ thresholdMs })}`),
}
