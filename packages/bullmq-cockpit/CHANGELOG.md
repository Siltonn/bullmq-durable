# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
It is versioned in lockstep with [`bullmq-durable`](../bullmq-durable).

## [0.2.0] - 2026-07-04

Tracks `bullmq-durable` 0.2.0's "one run = one job" protocol. Deploy the two
packages together; the cockpit tolerates 0.1.x leftovers during a rolling
upgrade.

### Changed

- **Consumes `bullmq-durable`'s public API**: the cockpit now depends on the
  runtime package and drives everything durable through its object model —
  one `DurableQueue` per queue (reusing the cockpit's BullMQ `Queue`
  instances plus one shared state store) for lists/counts/summaries, and
  `DurableRun` handles for logs/events and resume/retry/cancel/delete with
  legacy-carrier resolution. The hand-maintained Redis-protocol mirror
  (`server/durable/protocol.ts`) is DELETED — no more drift risk between the
  dashboard and the runtime. Plain-BullMQ deployments are unaffected: the
  dependency is inert without durable data.
- **Per-queue durable index**: reads follow the runtime's new
  `{prefix}:idx:{queue}:*` buckets; the seed's direct-written fixtures now
  register in the index (previously invisible to the index-driven list).
- **Exact pagination for terminal statuses**: completed / failed /
  compensation_failed / cancelled listings use the runtime's
  `listRunsPage` zset offset pages instead of a recency window. With a single
  queue and the default recency sort the offset is pushed down to Redis, so
  deep pages stay exact with no hard cap; cross-queue listings merge exact
  per-queue pages.
- **`durable.enabled` defaults to `"auto"`** — the README's "auto-detected"
  is now literally true: the cockpit probes the runtime's marker keys (one
  variadic `EXISTS` on the shared client, sticky once positive, re-checked
  every 30s while negative) and lights the durable UI up only when
  `bullmq-durable` is actually in use. A plain-BullMQ deployment pays one
  `EXISTS` per 30s and nothing else: no extra Redis connection (the runtime
  store dials lazily), no empty Durable nav, and the legacy 0.1.x
  orphan-resume scan — the one health check that hydrates real jobs — only
  runs while legacy markers exist. `true`/`false` remain as explicit
  overrides. The overview/health active-population summary is additionally
  single-flighted for 2s so simultaneous panels share one read.
- **NestJS: `forRoot` / `forRootAsync`** are the canonical module methods
  (mirroring `BullModule.forRoot`); `register` / `registerAsync` remain as
  aliases. The adapter no longer swallows a `queues` THUNK passed through the
  root options — it is read lazily per request and merged with
  `registerQueue` names, so any queue-name source plugs in (a ConfigService,
  or `bullmq-durable`'s new `DURABLE_QUEUE_NAMES` for zero
  double-registration when both modules run in one app).
- **Queue-name validation**: every client-supplied queue name is validated
  against the discovered/allow-listed set (404 for unknown names) — an
  arbitrary name can no longer create BullMQ meta keys or grow the queue
  cache without bound. Plus a startup warning when neither `auth` nor
  `readonly` is configured.

- **Protocol mirror** (`server/durable/protocol.ts`): done-bucket zsets are now
  scored by the terminal-transition timestamp (listed with `ZREVRANGE`, counted
  with `ZCARD`); legacy expiry/sentinel scores are tolerated until reaped. The
  retention-TTL mirror (`DEFAULT_RETENTION_MS`) is gone — state lives exactly
  as long as its job. Added the durable job-log line codec (`"$durable":1`).
- **Actions drive the run's single job**: resume promotes the delayed job (or
  revives it under the same id from the persisted input); retry / retry-
  compensation reactivate state then `job.retry()`/revive; cancel removes the
  job and marks the state cancelled with no TTL (the reaper collects it).
  Resume-job enqueueing (`enqueueResume` / `allocateResumeSeq`) is gone.
- **Logs read from the BullMQ job log** (tagged JSON lines with run/step/attempt
  attribution, surfaced in the log DTO); a leftover 0.1.x durable log list is
  merged in transitionally. Cockpit action logs are written via `job.log`.
- **Health**: `orphan_instance` now means "non-terminal instance whose single
  job is missing or terminally failed" (a failed job under a live instance =
  stall settlement died — retry from the dashboard). `orphan_resume_job` remains
  only as the legacy 0.1.x envelope check (removed in 0.3.0). Timeline shows
  parked sleeps as "sleeping until …" instead of "scheduled to retry".
- List/detail reads self-heal the index: listed ids whose instance hash is gone
  are dropped from the index buckets on read.

### Fixed

- **Durable-aware queue/job actions on the BullMQ pages**: with durable
  enabled, queue `drain` / `clean` now route through
  `DurableQueue.drain/clean` — a bare `Queue.drain/clean` stranded the
  removed jobs' run state (phantom active runs / orphaned terminal state
  until a worker restart). Job **remove** deletes the run through
  `DurableRun.delete` (state + carrier jobs), and job **retry** of a
  terminally-failed run re-drives it through the runtime (`run.retry()` /
  `run.retryCompensation()`) instead of silently replaying the stored
  failure without re-running any business code. Non-durable queues and runs
  in non-terminal statuses keep the plain BullMQ behavior.

## [0.1.5] - 2026-06-30

Released in lockstep with [`bullmq-durable`](../bullmq-durable) 0.1.5; no changes
to `bullmq-cockpit` itself.

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
