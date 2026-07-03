/**
 * The typed API facade.
 *
 * Every method delegates to the tRPC {@link trpc} client, so its arguments and
 * return value are **inferred from the server router** — there is not a single
 * hand-written wire type here anymore. The method names/signatures mirror the
 * old REST client so call sites stay unchanged; they just gained type safety
 * that tracks the server automatically.
 *
 * Path parameters (`queueName`, `jobId`, `instanceId`, `id`) become fields on
 * the procedure input, which is why the wrappers spread them into one object.
 */

import { trpc, type RouterInputs } from "./client"

export { errorMessage, errorStatus } from "./errors"

// Input shapes, derived from the router (not re-declared). The `queueName` /
// `id` path params are supplied by the wrapper, so callers pass only the body.
//
// `status` is kept as a plain string: it is a URL/UI-driven filter value, and
// the server validates it against its enum (a bad value → a `400`). The wrapper
// narrows it to the router's enum at the single call boundary below.
export type JobsQuery = Partial<Omit<RouterInputs["jobs"]["list"], "queueName" | "status">> & {
  status?: string
}
export type DurableQuery = Partial<Omit<RouterInputs["durable"]["list"], "status">> & {
  status?: string
}
export type CleanBody = Partial<Omit<RouterInputs["queues"]["clean"], "queueName">>
export type AddJobBody = Omit<RouterInputs["jobs"]["add"], "queueName">
export type AddSchedulerBody = Omit<RouterInputs["schedulers"]["add"], "queueName">
export type AlertRuleBody = RouterInputs["alerts"]["saveRule"]
export type AlertChannelBody = RouterInputs["alerts"]["saveChannel"]

export const api = {
  config: () => trpc.config.get.query(),

  // Overview
  overview: () => trpc.overview.stats.query(),
  signals: (windowMinutes?: number) => trpc.overview.signals.query({ windowMinutes }),

  // Activity (derived golden-signals: throughput + latency + job names)
  queueActivity: (queue: string, windowMinutes?: number) =>
    trpc.queues.activity.query({ queueName: queue, windowMinutes }),

  // Queues
  queues: () => trpc.queues.list.query(),
  queue: (name: string) => trpc.queues.get.query({ queueName: name }),
  pauseQueue: (name: string) => trpc.queues.pause.mutate({ queueName: name }),
  resumeQueue: (name: string) => trpc.queues.resume.mutate({ queueName: name }),
  drainQueue: (name: string) => trpc.queues.drain.mutate({ queueName: name }),
  cleanQueue: (name: string, body: CleanBody) =>
    trpc.queues.clean.mutate({ queueName: name, ...body }),

  // Jobs
  jobs: (queue: string, query: JobsQuery) =>
    trpc.jobs.list.query({
      queueName: queue,
      ...query,
      status: query.status as RouterInputs["jobs"]["list"]["status"],
    }),
  addJob: (queue: string, body: AddJobBody) =>
    trpc.jobs.add.mutate({ queueName: queue, ...body }),
  job: (queue: string, jobId: string) => trpc.jobs.get.query({ queueName: queue, jobId }),
  jobLogs: (queue: string, jobId: string) =>
    trpc.jobs.logs.query({ queueName: queue, jobId }),
  jobDependencies: (queue: string, jobId: string) =>
    trpc.jobs.dependencies.query({ queueName: queue, jobId }),
  jobFlow: (queue: string, jobId: string) =>
    trpc.jobs.flow.query({ queueName: queue, jobId }),
  retryJob: (queue: string, jobId: string) =>
    trpc.jobs.retry.mutate({ queueName: queue, jobId }),
  promoteJob: (queue: string, jobId: string) =>
    trpc.jobs.promote.mutate({ queueName: queue, jobId }),
  removeJob: (queue: string, jobId: string) =>
    trpc.jobs.remove.mutate({ queueName: queue, jobId }),
  duplicateJob: (queue: string, jobId: string) =>
    trpc.jobs.duplicate.mutate({ queueName: queue, jobId }),
  bulkRetry: (queue: string, ids: string[]) =>
    trpc.jobs.bulkRetry.mutate({ queueName: queue, ids }),
  bulkRemove: (queue: string, ids: string[]) =>
    trpc.jobs.bulkRemove.mutate({ queueName: queue, ids }),

  // Schedulers
  schedulers: () => trpc.schedulers.list.query(),
  queueSchedulers: (queue: string) => trpc.schedulers.listForQueue.query({ queueName: queue }),
  addScheduler: (queue: string, body: AddSchedulerBody) =>
    trpc.schedulers.add.mutate({ queueName: queue, ...body }),
  removeScheduler: (queue: string, id: string) =>
    trpc.schedulers.remove.mutate({ queueName: queue, id }),

  // Flows
  flows: () => trpc.flows.list.query(),

  // Alerts
  alerts: () => trpc.alerts.overview.query(),
  alertRules: () => trpc.alerts.listRules.query(),
  saveAlertRule: (body: AlertRuleBody) => trpc.alerts.saveRule.mutate(body),
  removeAlertRule: (id: string) => trpc.alerts.removeRule.mutate({ id }),
  toggleAlertRule: (id: string) => trpc.alerts.toggleRule.mutate({ id }),
  alertChannels: () => trpc.alerts.listChannels.query(),
  saveAlertChannel: (body: AlertChannelBody) => trpc.alerts.saveChannel.mutate(body),
  removeAlertChannel: (id: string) => trpc.alerts.removeChannel.mutate({ id }),
  testAlertChannel: (id: string) => trpc.alerts.testChannel.mutate({ id }),

  // Metrics + Redis
  metrics: (queue: string) => trpc.queues.metrics.query({ queueName: queue }),
  redisInfo: () => trpc.health.redis.query(),

  // Durable
  durableInstances: (query: DurableQuery) =>
    trpc.durable.list.query({
      ...query,
      status: query.status as RouterInputs["durable"]["list"]["status"],
    }),
  durableInstance: (id: string) => trpc.durable.get.query({ instanceId: id }),
  durableSteps: (id: string) => trpc.durable.steps.query({ instanceId: id }),
  durableEvents: (id: string) => trpc.durable.events.query({ instanceId: id }),
  durableLogs: (id: string) => trpc.durable.logs.query({ instanceId: id }),
  durableResume: (id: string) => trpc.durable.resume.mutate({ instanceId: id }),
  durableRetry: (id: string) => trpc.durable.retry.mutate({ instanceId: id }),
  durableRetryCompensation: (id: string) =>
    trpc.durable.retryCompensation.mutate({ instanceId: id }),
  durableCancel: (id: string) => trpc.durable.cancel.mutate({ instanceId: id }),
  durableDelete: (id: string) => trpc.durable.delete.mutate({ instanceId: id }),

  // Health
  health: () => trpc.health.health.query(),
  stuck: (thresholdMs?: number) => trpc.health.stuck.query({ thresholdMs }),
}
