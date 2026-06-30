# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-06-29

### Added

- **Saga compensation.** A completed step can register a compensation through the
  new `onRollback` step option — `ctx.step(key, { onRollback }, fn)`. When an
  instance reaches a terminal failure, compensations run for the steps that
  actually completed, in reverse order, as durable, retried steps of their own (so
  they survive resumes and must be idempotent — use `ctx.stepId(key)` as a
  business idempotency key). `onRollback` is either a `RollbackFn<T>` —
  `({ output, error }) => …`, where `output` is the step's checkpoint snapshot — or
  `{ handler, retry }` to give the compensation its own retry policy. Bare
  functions use the worker-level `defaultRollbackRetry` (defaults to
  `{ attempts: 5, backoff: "exponential", delay: "1s", maxDelay: "30s" }`).
- **Terminal-failure handler.** A worker-level `onFailure`, or a per-job
  `{ run, onFailure }` handler, runs once — _after_ compensation — for genuine
  failures only (control-flow signals like yield / `retryLater` / cancel never
  reach it). It receives `(job, ctx, failure)` where `failure` is a
  `DurableFailureInfo` (`{ error, failedStep?, completed, compensation }`); its own
  `ctx.step` calls are durable and idempotent.
- Two new terminal instance statuses: `compensating` (rollbacks in progress) and
  `compensation_failed` (a compensation could not be completed and needs human
  intervention). `RetentionOptions.compensationFailed` gives the latter its own TTL
  (defaults to `"30d"`, kept longer than `failed`). A `CompensationReport`
  (`{ rolledBack, failed }`) is persisted on the instance and surfaced to
  `onFailure` and the dashboard.
- NestJS: `@DurableFailure(jobName)` marks a method on a `@DurableProcessor` as the
  terminal-failure handler for the sibling `@DurableProcess`; `forRootAsync` and
  `registerQueueAsync` source `connection` (and other options) from DI (e.g. a
  `ConfigService`); a queue's `processor` class(es) can be listed on
  `registerQueue({ processor })` so they are auto-registered and exported (no
  separate `providers` entry to forget); `defaultRollbackRetry` is configurable at
  the root and per queue.
- `isDurableControlSignal(error)` — a type guard covering every durable
  control-flow signal (yield / retry-later / cancel), so a `catch` can re-throw
  them without enumerating each variant (forgetting `DurableCancelledError` is an
  easy way to make a cancelled job run its failure settlement).

### Changed

- **Queues and workers are now payload-typed, mirroring BullMQ** — there is no
  longer a name→payload job map to declare. `DurableQueue<Data, Result>` types the
  payload, the job name passed to `queue.add(name, data)` is a free routing label,
  and each worker handler types its own payload through its `DurableJob<Data,
  Result>` parameter. **Breaking:** the job-map generics and the `DurableJobMap` /
  `DurableJobSpec` / `JobData` / `JobResult` types are removed. Migrate
  `new DurableQueue<{ video: { data: In; result: Out } }>(…)` to
  `new DurableQueue<In, Out>(…)`, and annotate handler `job` parameters explicitly.

### Fixed

- A terminally-failed step now replays its stored error without re-running its body
  — symmetric with a completed step replaying its result — so its side effect can't
  re-fire on every compensation/resume tick. Jobs with no compensation and no
  `onFailure` still fail straight to `failed` exactly as in 0.1.x (no `compensating`
  phase, no extra metadata written), and a cancelled instance runs neither
  compensation nor `onFailure`.

## [0.1.2] - 2026-06-28

### Added

- **Status index** for read-only observers (the dashboard): `RedisStateStore`
  maintains an additive `{prefix}:idx:*` index from the first instance, kept in
  lock-step with every status transition, so per-status counts and the in-flight
  set can be read without scanning Redis. It lives inside the bundled Redis store
  and is bounded by the same retention TTL as the instance state.
- `RetentionOptions.cancelled` — TTL for cancelled instances (defaults to `"24h"`).

### Changed

- **Finished instances now expire by default.** `retention` falls back to a safe
  default (`completed: "24h"`, `failed: "7d"`, `cancelled: "24h"`) when not
  configured, so a durable instance's state — which outlives its BullMQ jobs (the
  original job completes on the first yield, resume ticks are removed immediately)
  — no longer accumulates in the store forever. Set `retention` explicitly to
  override.
- **Terminal transitions are now atomic with retention.** `StateStore`'s
  `completeInstance` / `failInstance` / `cancelInstance` take an optional `ttlMs`;
  the bundled Redis store applies the status change, the index move, the retention
  TTL and the bucket prune in a single Lua script, so a crash can never leave a
  finished instance un-expired or its index entry un-pruned. `DurableQueue.cancel()`
  applies the default cancelled retention too. The new parameter is optional, so
  existing custom `StateStore` implementations keep working unchanged.

### Fixed

- A reused BullMQ job id no longer leaves a phantom entry in the status index: a
  fresh instance clears any stale terminal-bucket entry under the same id on init,
  so it is never counted as both in-flight and finished.

## [0.1.1] - 2026-06-24

### Added

- `DurableBullRootOptions.stateStore` — supply a shared `StateStore` for the
  whole NestJS module (e.g. an existing client, or a `MemoryStateStore` in tests).

### Changed

- NestJS: every queue and worker now reuses a single shared `StateStore`, so an
  app with N queues/workers opens one Redis state connection instead of N.

### Fixed

- `DurableQueue.cancel()` removes the pending resume job by its exact id instead
  of scanning the entire BullMQ delayed set — constant-time regardless of how
  many delayed jobs the queue holds.

## [0.1.0] - 2026-06-23

### Added

- Initial release.
- `DurableQueue` and `DurableWorker` — thin wrappers over BullMQ whose processor
  receives a durable context: `processor(job, ctx)`.
- Durable context API: `ctx.step` (run-once, checkpointed), `ctx.sleep` /
  `ctx.sleepUntil` (yield without holding a worker), `ctx.retryLater`,
  `ctx.nonRetryable`, `ctx.log`, and `ctx.stepId`.
- Per-step retry policy with `fixed` / `exponential` backoff, optional `maxDelay`
  (exponential backoff is capped at a 1-hour ceiling by default), and
  worker-level `defaultStepOptions`. `retryLater` polls until the step stops
  throwing it, unless an explicit `attempts` caps it.
- Configurable `resumeAttempts` (default `3`) so a transient failure to enqueue a
  resume tick self-heals via BullMQ retry instead of stranding the instance.
- Step results are checkpointed via JSON, and the first run returns the same
  serialised shape a replay would — so code can't work once and break on resume.
- `RedisStateStore` (default) and `MemoryStateStore`, plus a pluggable
  `StateStore` interface for custom backends.
- Per-instance advisory locking with heartbeat renewal, retention TTLs,
  cancellation, and bounded structured logs.
- Queue inspection helpers: `getDurableState`, `getDurableSteps`,
  `getDurableLogs`, and `cancel`.
- Optional NestJS integration under `bullmq-durable/nestjs`: `DurableBullModule`,
  `@DurableProcessor`, `@DurableProcess`, and `@InjectDurableQueue`.
- Dual ESM/CJS build with type declarations, end-to-end TypeScript job-map
  inference, and a comprehensive test suite.
