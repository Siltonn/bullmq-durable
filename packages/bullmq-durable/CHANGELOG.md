# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
