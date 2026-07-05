# bullmq-cockpit

Modern dashboard and durable instance inspector for [BullMQ](https://docs.bullmq.io/).

![BullMQ Cockpit — the Overview: four golden signals, a Needs-attention banner, and a worst-first grid of queue-composition cards](docs/overview.png)

`bullmq-cockpit` is an embeddable, framework-agnostic admin UI for any BullMQ
deployment. It works out of the box for **plain BullMQ** users (queues, jobs,
actions) and lights up a first-class **durable inspector** when it detects
[`bullmq-durable`](../bullmq-durable) state in Redis — step timelines, sleep /
retry / resume controls, and stuck detection.

- **Server**: [Hono](https://hono.dev/) + Zod, mounted under any base path.
- **Client**: React + Vite + TanStack Router/Query/Table + HeroUI + Tailwind.
- **Adapters**: Express, Fastify, NestJS, and a standalone CLI.

## At a glance

```yaml
package: bullmq-cockpit          # embeddable dashboard; publishes UI + server + CLI
version: 0.2.0                   # versioned in lockstep with bullmq-durable
requires: node >=18, bullmq ^5, a reachable Redis
install: npm i bullmq-cockpit    # or: npx bullmq-cockpit --redis redis://…
works-with:
  plain-bullmq: first-class      # queues/jobs/flows/schedulers/metrics/alerts, no durable needed
  bullmq-durable: auto-detected  # consumes the runtime package via its DurableQueue/DurableRun API
durable-protocol: 0.2.x          # one run = one job; sleeping runs are `delayed` jobs
security:
  auth: open by default          # startup WARNING unless `auth` or `readonly` is set
  queue-names: validated         # unknown client-supplied queue names → 404 (no Redis pollution)
  readonly: strips every write permission
api: tRPC under {basePath}/api/trpc (AppRouter type exported)
```

---

## Features

**Plain BullMQ**

- **Overview** — the four golden signals at a glance (throughput + sparkline, error
  rate, queue wait, saturation), a worst-first **queue health table**, distribution
  donuts, and a jobs-by-queue chart.
- **Queues** — health/composition, no-worker warnings, pause / resume / drain / clean.
- **Jobs** — status-tabbed list with search, full job detail (data / return / logs /
  stacktrace), **Add job**, **Duplicate**, retry / promote / remove, and **bulk
  retry / remove** via row selection.
- **Flows** — FlowProducer parent → children trees, both on a dedicated **Flows**
  page and rendered inline on every job that participates in one.
- **Schedulers** — repeatable & cron job schedulers: list across queues, add (cron
  pattern or fixed interval), and remove.
- **Metrics** — a per-queue golden-signal deep-dive: throughput over time, **latency
  distribution** (processing p50/p95/max + queue wait) and a **per-job-name**
  breakdown. Throughput uses BullMQ `getMetrics` when the worker opts in, and
  otherwise **derives** everything from recent jobs' timestamps — so latency and
  throughput work even without metrics collection enabled. Plus a **Redis server**
  panel (version, memory, clients, hit-rate) on the Health page.
- **Alerts** — live rules over queue & durable health (failed, backlog, missing
  workers, stuck instances) evaluated server-side, with **Slack / webhook**
  notifications dispatched by a background evaluator on ok→firing transitions.

**Durable** (auto-detected from `bullmq-durable` state — see [Durable inspector](#durable-inspector))

- step flow diagram, sleep / retry / resume controls, **saga compensation**
  (rollback timeline + retry-compensation), synthesized event feed, inline durable
  panel on the job page, and four-class stuck detection.

---

## Quick start (standalone)

```bash
npx bullmq-cockpit --redis redis://localhost:6379 --queues generation,emails --port 3001
# → open http://localhost:3001
```

The CLI auto-discovers queues if `--queues` is omitted (scanned once at startup,
then cached — restart to pick up new queues). Run `bullmq-cockpit --help` for
every flag (`--base-path`, `--readonly`, `--no-durable`, …).

## Embedding

Every adapter mounts the **same** dashboard under a base path you choose. All
API and asset routes live under that path, so they never collide with your app.

### Express

```ts
import { createBullMQCockpit } from "bullmq-cockpit/express"

app.use(
  "/admin/bullmq",
  createBullMQCockpit({
    connection,
    queues: ["generation", "emails"],
    durable: { enabled: true },
    auth: async ({ req }) => req.user?.role === "admin",
  }),
)
```

### Fastify

```ts
import { createBullMQCockpit } from "bullmq-cockpit/fastify"

await fastify.register(createBullMQCockpit({ connection }), { prefix: "/admin/bullmq" })
```

### NestJS

```ts
import { BullMQCockpitModule } from "bullmq-cockpit/nestjs"

@Module({
  imports: [
    BullMQCockpitModule.register({ path: "/admin/bullmq", connection, queues: ["emails"] }),
  ],
})
export class AdminModule {}
```

Under NestJS the dashboard **never auto-discovers** queues by scanning Redis — you
declare them explicitly. List them at the root with `queues`, and/or contribute
them from any feature module with `registerQueue` (mirrors
`DurableBullModule.registerQueue`); the lists are merged:

```ts
@Module({
  imports: [BullMQCockpitModule.registerQueue("media", "billing")],
})
export class MediaModule {}
```

Source `connection` (and `auth`) from DI with `registerAsync`:

```ts
@Module({
  imports: [
    BullMQCockpitModule.registerAsync({
      path: "/admin/bullmq",
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ connection: config.get("redis") }),
    }),
  ],
})
export class AdminModule {}
```

The cockpit's Redis connections are built lazily and released automatically on
application shutdown (enable `app.enableShutdownHooks()` to also release them on
`SIGTERM`/`SIGINT`).

This module runs on **both** the default Express platform and
`@nestjs/platform-fastify` with no extra setup — Nest's Fastify platform bundles
the middie engine, so the dashboard middleware works unchanged. (Prefer a
standalone plugin? Mount [`bullmq-cockpit/fastify`](#fastify) directly instead.)

One caveat: because the dashboard mounts as middleware, Nest guards/interceptors
don't run for its routes — put authorization in the `auth` hook (whose `req` is
the raw request).

### Hono (directly)

```ts
import { createCockpitApp } from "bullmq-cockpit"

const { app, context } = createCockpitApp({ connection })
// mount app.fetch wherever you like; call context.close() on shutdown
```

## Options

| Option              | Default            | Description                                                           |
| ------------------- | ------------------ | -------------------------------------------------------------------- |
| `connection`        | —                  | BullMQ/ioredis connection (options or a client). **Required.**       |
| `queues`            | auto-discover      | Explicit queue allow-list. Client-supplied queue names are always validated against this list (or the discovered set) — unknown names get a 404 instead of creating BullMQ keys. |
| `bullPrefix`        | `"bull"`           | BullMQ key prefix.                                                   |
| `basePath`          | inferred           | Mount path; adapters usually infer it.                              |
| `durable.enabled`   | `true`             | Enable the durable instance inspector.                              |
| `durable.prefix`    | `"bullmq-durable"` | `bullmq-durable` Redis key prefix.                                  |
| `durable.stuckThresholdMs` | `300000`    | Staleness threshold for stuck detection.                            |
| `auth`              | open               | Authorization hook (see below). **Set this in production** — without it (and without `readonly`) the server logs a startup warning. |
| `readonly`          | `false`            | Disable every mutating action.                                      |

### Auth & permissions

The `auth` hook runs for every request and returns either a boolean or a
principal with explicit permissions:

```ts
auth: async ({ req, header, path, method }) => {
  const user = await getUser(header("authorization"))
  if (!user) return false
  return {
    allowed: true,
    user: { id: user.id, name: user.name, role: user.role },
    permissions: user.role === "admin"
      ? undefined // all permissions
      : ["queue:read", "job:read", "durable:read"], // read-only viewer
  }
}
```

Permissions: `queue:read|write`, `job:read|write`,
`durable:read|resume|retry|cancel|delete`, `dangerous:write` (clean/drain).
In `readonly` mode every write permission is stripped regardless of the hook.

## Durable inspector

![A durable instance in the inspector: status + metadata header, and an execution timeline of steps, retries, sleeps and logs with per-step durations](docs/durable-inspector.png)

When durable support is on, the **Durable** section lists instances with their
derived status (the runtime's coarse `yielded` is split into `sleeping`,
`retrying`, `waiting`). Under the 0.2.x protocol **one run rides one BullMQ
job** — a sleeping run is simply that job parked in the `delayed` set, and every
action drives that job with BullMQ's own primitives. The detail view shows:

- a **step timeline** (`✓ completed · 421ms`, `↻ retrying · attempt 12 · next in 8s`, …),
  with `ROLLBACK` / `SETTLE` tags for compensation and `onFailure` steps,
- per-step result previews, errors, and timings,
- input / output / a synthesized event feed,
- **attributed logs**: `ctx.log` lines carry which delivery (`Delivery #2`),
  which step + attempt (`charge-card#2`), and runtime failure events
  (`step_retry`, `settled`, …) — multi-delivery runs read as separate sections
  instead of one merged stream,
- **Resume now** (promotes the delayed job, or revives it by id if it was
  removed), **Retry**, **Retry compensation**, **Cancel**, and **Delete state**.

**Saga compensation** is first-class: the `compensating`
and `compensation_failed` statuses appear in the Overview summary, status filter,
and counts. A `compensation_failed` instance shows a "manual intervention needed"
banner with its compensation report (what rolled back vs. failed) and a **Retry
compensation** action that re-runs only the failed compensation steps.

The **Health** page surfaces stuck instances by class: `running_stale`,
`resume_missed`, `orphan_instance` (the run's job is missing — hand-deleted —
or `failed` with settlement unfinished), and the legacy `orphan_resume_job`
(0.1.x envelope ticks during a rolling upgrade; removed in 0.3.0).

## API (tRPC)

The API is **[tRPC](https://trpc.io)**, mounted under `{basePath}/api/trpc`. The
client and server share one contract — the `AppRouter` type — so every call is
fully type-checked end-to-end with **no hand-written wire types**: procedure
inputs are validated by Zod and their outputs are inferred from the server.

```
config.get
overview.{stats,signals}
queues.{list,get,metrics,activity,pause,resume,clean,drain}
jobs.{list,add,get,logs,dependencies,flow,retry,promote,remove,duplicate,bulkRetry,bulkRemove}
schedulers.{list,listForQueue,add,remove}
flows.list
alerts.{overview,listRules,saveRule,removeRule,toggleRule,listChannels,saveChannel,removeChannel,testChannel}
durable.{list,get,steps,events,logs,resume,retry,retryCompensation,cancel,delete}
health.{health,redis,stuck}
```

Errors carry an HTTP status (`data.httpStatus`): `400` for invalid input, `403`
for a missing permission or read-only mode, `404` for a missing resource. The
`AppRouter` type is exported from the package root for typing your own clients:

```ts
import type { AppRouter } from "bullmq-cockpit"
```

## Local development

The cockpit reads **real** Redis data — there is no mock mode — so local dev needs
a Redis. The package ships a throwaway one and a seed of demo data, so you can go
from zero to a populated dashboard in one command:

```bash
pnpm --filter bullmq-cockpit demo
# = redis:up  +  seed  +  dev   →  http://localhost:3010
```

Or step by step:

```bash
pnpm --filter bullmq-cockpit redis:up     # docker compose up -d (local Redis on :6379)
pnpm --filter bullmq-cockpit seed         # populate demo data (re-runnable)
pnpm --filter bullmq-cockpit seed --reset # …or wipe Redis first, then seed
pnpm --filter bullmq-cockpit dev          # Hono API (:3011) + Vite (:3010, proxies /api)
pnpm --filter bullmq-cockpit redis:down   # stop Redis (redis:reset wipes the volume)
```

The seed creates a realistic spread so **every** view has something to show:

| Queue                    | What you'll see                                          |
| ------------------------ | -------------------------------------------------------- |
| `emails`, `payments`     | completed + failed jobs (with stacktraces)               |
| `notifications`, `exports-csv` | waiting + delayed jobs                             |
| `generation` (durable)   | completed, a **flaky-step retry history**, sleeping, retrying, failed, **saga compensation** (rolled-back / `compensation_failed` / parked `compensating`), a **job-level backoff** run (waiting out BullMQ attempts), cancelled — plus `running_stale`, a legacy `orphan_resume_job`, and a legacy shim-carried run |
| `exports` (durable)      | a second durable queue (completed + sleeping)            |
| `media` (durable)        | a 6-step pipeline: completed (+ a synthesized waterfall showcase), sleeping, failed deep in `transcode`, retrying with a live delayed carrier, `resume_missed`, and an `orphan_instance` |

### Pointing at your own data

Instead of seeding, point the cockpit at the Redis your app/workers already use —
you'll see your real queues, jobs, and durable instances:

```bash
REDIS_URL=redis://localhost:6379 COCKPIT_QUEUES=generation,emails \
  pnpm --filter bullmq-cockpit dev
```

Recognized env vars: `REDIS_URL`, `COCKPIT_QUEUES` (comma-separated; omit to
auto-discover), `COCKPIT_NO_DURABLE=1`, `COCKPIT_DEBUG=1`.

## Build

```bash
pnpm --filter bullmq-cockpit build   # tsup (server) → dist/, then Vite → dist/client
```

The server serves `dist/client` automatically; override with the `clientDir`
option for advanced embedding.

## License

MIT
