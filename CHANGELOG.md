# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
