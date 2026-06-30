# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
It is versioned in lockstep with [`bullmq-durable`](../bullmq-durable).

## [0.1.4] - 2026-06-29

### Fixed

- **NestJS module now runs on Fastify as well as Express**, from the same
  `BullMQCockpitModule` — no need to fall back to the standalone
  `bullmq-cockpit/fastify` plugin. Two platform-portability bugs are fixed: the
  mount wildcard is now `${path}/*` (the previous `(.*)` form failed to match
  nested dashboard routes on NestJS 10 + Express), and the request path is read
  from `req.originalUrl` (on Fastify, Nest's bundled middie engine rewrites
  `req.url` to the post-match remainder, which dropped the sub-path and routed
  every request to `/`). Verified across NestJS 10/11 × Express/Fastify.

## [0.1.3] - 2026-06-29

### Added

- **Saga / compensation support across the durable inspector**, tracking
  `bullmq-durable` 0.1.3's new lifecycle. The `compensating` and
  `compensation_failed` statuses are first-class in the Overview summary, the
  status filter, the instance list, and the counts. The instance panel shows the
  per-step **compensation report** (what rolled back vs. what failed) and the point
  of failure; the execution timeline tags rollback steps `ROLLBACK` and
  `onFailure` steps `SETTLE`; and a `compensation_failed` instance gets a "manual
  intervention needed" banner with a **Retry compensation** action
  (`POST /api/durable/instances/:id/retry-compensation`, behind `durable:retry`)
  that re-runs only the failed compensation steps and leaves succeeded ones cached.
- **NestJS:** `BullMQCockpitModule.registerAsync({ imports, inject, useFactory })`
  sources `connection` / `auth` from DI; `BullMQCockpitModule.registerQueue(...names)`
  contributes queue names from any feature module (mirrors
  `DurableBullModule.registerQueue`), merged with the root `queues` list. Redis
  connections are now built lazily and released on application shutdown
  (`OnApplicationShutdown`; pair with `app.enableShutdownHooks()` to also release
  on `SIGTERM`/`SIGINT`).

### Changed

- **Queue auto-discovery now scans Redis once at startup and caches the result**
  for the process lifetime, instead of scanning on every use — new queues require a
  restart to appear. `options.queues` additionally accepts a `() => string[]` thunk
  (used by the NestJS registry), and supplying it disables auto-discovery
  altogether. Under NestJS the dashboard never auto-discovers: it shows only the
  queues you register explicitly.
- Durable step progress now counts only forward (`main`-phase) work steps, so
  internal compensation / failure steps and sleeps no longer inflate the bar.
- NestJS: `path` is the canonical mount-path option (the module no longer accepts
  `basePath`).

### Fixed

- **Retry now actually re-runs a failed step.** Because the runtime replays a
  failed step's stored error instead of re-running it, a plain retry has to clear
  the failed step's records first — it now does (along with `failureError` /
  `failedStep` / `compensation`), so the step re-runs on replay.
- The reported point of failure now only considers forward (`main`-phase) steps, so
  an internal `__rollback__` / `__failure__` step is never mis-reported as the step
  to debug. Resuming a `compensation_failed` instance is rejected with a message
  pointing to "retry compensation".

## [0.1.2] - 2026-06-28

Initial release.

### Added

- Embeddable, framework-agnostic dashboard for any BullMQ deployment: **Overview**
  (four golden signals + a worst-first queue health grid), **Queues**, **Jobs**,
  **Flows**, **Schedulers**, **Metrics**, and **Alerts** (server-side evaluation
  with Slack / webhook notifications). Adapters for Express, Fastify, NestJS, Hono,
  and a standalone CLI; an `auth` hook with per-action permissions; and a
  `readonly` mode.
- **Durable inspector**, auto-detected from `bullmq-durable` state in Redis:
  per-status counts, an instance list, step timelines, sleep / retry / resume /
  cancel / delete controls, a synthesized event feed, and four-class stuck
  detection. It speaks the durable Redis protocol directly (the runtime is never
  imported) and reads the status index, so counts and lists never scan the
  keyspace. Reads are read-only and exact by expiry score; mutating actions are
  atomic (MULTI/EXEC) and keep the index consistent — delete also removes the
  pending resume tick, so a non-terminal instance can't be resurrected.
