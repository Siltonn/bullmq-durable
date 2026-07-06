# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-04

**One run = one BullMQ job.** The resume-job architecture is gone: suspensions
(`ctx.sleep`, step backoff, `retryLater`) now use BullMQ's native step-jobs
pattern (`job.moveToDelayed` + `DelayedError`) on the run's own job. BullMQ's
own options — `attempts`, `backoff`, `priority`, `removeOnComplete`,
`removeOnFail`, `keepLogs` — apply to the whole run, natively.

### Changed

- **`cancel(jobId)` aligns with BullMQ's cancellation boundary**: existing
  state is marked cancelled (the run stops at its next checkpoint); when no
  durable state exists yet the job is best-effort removed and NO cancelled
  state is fabricated — an already active/locked job cannot be force-stopped
  from outside, exactly as in BullMQ.
- **`clean()` follows up with a reconcile pass**: removed ids that don't map
  1:1 onto instance ids (e.g. a 0.1.x legacy resume job) are collected by the
  reaper instead of being parsed heuristically.
- **Boundary-error classification is module-instance-proof**: the
  `failed`-listener now identifies `DurableTerminalJobError` /
  `DurableCancelledJobError` via `isDurableBoundaryError` (exported) — a
  `Symbol.for` marker plus class-name fallback on top of `instanceof` — so a
  duplicated bullmq-durable copy (CJS/ESM dual package) cannot demote a
  settled run into a spurious settle tick or a mistimed one.
- **`bullJobKeysExist`** (renamed from `bullJobsExist`): runtime-guards the Redis client instead of
  blindly asserting `exists`, pipelines the per-key `EXISTS` calls into one
  round trip when supported, and treats per-key errors as "existing" so
  uncertainty can never reap live state.
(breaking, with a soft landing)

- **Job dispatch**: no more resume jobs / `__durable__` envelopes / `:resume:N`
  job ids. The run's job stays visible (`delayed` while sleeping) for its whole
  life; `waitUntilFinished` now resolves at TRUE completion (previously it
  resolved at the first yield).
- **Two retry budgets**: step errors are governed by the step's own `retry`
  (never consuming job attempts — the old "keep BullMQ `attempts: 1`" advice is
  inverted: set `attempts`/`backoff` freely, they retry *non-step* errors with
  replay making re-execution safe). Terminal failures throw
  `DurableTerminalJobError` / `DurableCancelledJobError` (both
  `UnrecoverableError`s) so BullMQ never burns attempts on settled runs.
- **State lifecycle follows the job** (`RetentionOptions` removed): durable
  state lives exactly as long as its BullMQ job. `removeOnComplete` /
  `removeOnFail` (every form) govern the run record; the runtime reaps state
  whose job is gone — eventually consistent by design: reap passes run on
  worker start, terminal outcomes, reads, and explicit `reconcile()`; external
  BullMQ-direct deletions converge at the next trigger. `DurableQueue.clean()` /
  `drain()` / `obliterate()` pass through to BullMQ and delete the matching
  state. ⚠️ `removeOnFail: true` now erases `compensation_failed` records too —
  keep failed jobs with `{ age }` / `{ count }`.
- **Logs live in the BullMQ job log**: `ctx.log` writes tagged JSON lines
  (`"$durable":1`) with run/step/attempt attribution; the runtime auto-logs
  failure-path events. Bound them with `defaultJobOptions.keepLogs`; read via
  `queue.getDurableLogs()` / `parseJobLogs()`. The 0.1.x durable log list is
  gone (leftovers are cleaned by the reaper).
- **Options ARE BullMQ options**: `DurableQueueOptions extends QueueOptions`,
  `DurableWorkerOptions extends WorkerOptions` (`concurrency`, `lockDuration`,
  `stalledInterval`, `limiter`, `settings.backoffStrategy`, … pass through).
  Deprecated 0.1.x fields are still accepted with a one-shot warning and are
  removed in 0.3.0: `bullPrefix` → `prefix`, `bullWorkerOptions` → top level;
  `lockTimeout`, `retention`, `maxLogs`, `resumeAttempts` are ignored. The flat
  retry shape `{ backoff: "exponential", delay, maxDelay }` still works; prefer
  `backoff: { type, delay, jitter, maxDelay }` (BullMQ's vocabulary).
- **Step retry shape**: `retry.backoff` now mirrors BullMQ's `backoff` option
  (number / duration string / `{ type, delay, jitter, maxDelay }`), including
  jitter semantics.
- **NestJS**: root/registration options gain `prefix`, `defaultJobOptions` and
  `workerOptions` (a `WorkerOptions` sub-object); the module now closes every
  queue/store it created (including per-queue `durablePrefix` stores) and also
  implements `OnApplicationShutdown`.
- **Custom `StateStore` interface** (for store authors): `initInstance` gained
  begin-tick semantics, new `beginStep` + reaper primitives (`listActive`,
  `listOldestTerminal`, `removeInstances`, `wipeAll`), lock-token-fenced
  terminal transitions; `appendLog`/`getLogs`/`nextResumeSeq`/`expireInstance`
  removed.

### Added

- **`DurableRun` + the run collection on `DurableQueue`** — the public object
  model mirrors BullMQ's own `Queue`/`Job` split, so dashboards, ops scripts
  and application code call methods instead of hand-mirroring the Redis
  layout. `DurableQueue` owns the collection: `run(jobId)` / `getRun` vend
  handles, `listRuns` (index windows) / `countRuns` / `activeRuns` /
  `summarizeRuns` / `reconcile` read it, and an injectable `bull` option
  reuses a host-held BullMQ `Queue`. `DurableRun` is the run-scoped entity:
  `state` / `steps` / `logs` / `events` / `summary`, `carrier` /
  `carrierState` (0.1.x legacy-fallback resolution built in, single source),
  and the actions `resume` / `retry` / `retryCompensation` / `cancel` /
  `delete`. Action errors are `DurableActionError` with a `code`
  (`not_found` / `invalid_state`) for clean HTTP mapping. The semantic layer
  ships alongside (`deriveView`, `classifyLocalStuck`, `synthesizeEvents`,
  `sleepWakeAt`, batch `summarizeInstances`) — `bullmq-cockpit` 0.2.0
  consumes exactly this API and no longer mirrors the protocol by hand.
- **Deployment detection for dashboards**: `DurableWorker` announces its queue
  in the `{prefix}:queues` registry at startup (idempotent
  `StateStore.registerQueue`), so a durable deployment is detectable BEFORE
  the first run ever ticks; `durableProbeKeys(prefix)` exports the marker keys
  (current + 0.1.x legacy) so dashboards can probe with one variadic `EXISTS`
  on their own client — no layout knowledge, no SCAN. `RedisStateStore` now
  dials Redis lazily on first command (constructing a store — e.g. just to
  probe — no longer costs a connection).
- **NestJS: `DURABLE_QUEUE_NAMES`** — an exported injection token resolving to
  a lazy `() => string[]` of every queue registered through
  `DurableBullModule.registerQueue(Async)`. Wire it into dashboards (e.g.
  `BullMQCockpitModule.forRootAsync`'s `queues`) so durable-registered queues
  appear without a second registration.
- **Top-level `{ run, onFailure }` processor**: `DurableWorker` now accepts a
  default handler object alongside the single-function and per-name-map forms —
  for the "one queue = one workflow" shape, `onFailure` pairs with the
  processor instead of hiding in worker options. `run` becomes a reserved word
  in the map form (a job actually named "run" uses `{ run: { run: fn } }`).
- **Exact terminal pagination**: `DurableQueue.listRunsPage({ kind, offset,
  limit, order? })` pages one done bucket by terminal-transition time via a
  real zset offset (`StateStore.listTerminalPage` primitive) — deep pagination
  stays exact, unlike the recency-window `listRuns`.
- **Injection & tuning options**: `DurableQueueOptions.bullmq` reuses a
  host-held BullMQ `Queue` (ownership stays with the caller), and
  `reaper: { terminalBatchSize, throttleMs, orphanGraceMs }` tunes the state
  reaper on both queue and worker (terminal batch default raised 8 → 32;
  orphan grace default 10s).
- **Per-queue status index**: `{prefix}:idx:{queue}:active` and
  `{prefix}:idx:{queue}:done:{status}` (plus a `{prefix}:queues` registry)
  replace the global buckets — each bucket now scales with ONE queue's own
  `removeOn*` retention (the same order as BullMQ's per-queue zsets), busy
  neighbours can't bloat another queue's scans, and `obliterate`/wipes drain
  chunked instead of materialising whole buckets. Pre-release global buckets
  are read + reaped during a transition window (removed in 0.3.0).

### Fixed

- `ctx.sleep` crash window: a sleep is now persisted as `running` + `nextRunAt`
  and completes only once elapsed — a crash between persisting and suspending
  can no longer skip the wait on re-delivery. Step backoffs are honoured the
  same way on early re-delivery (stall takeover / promote).
- Concurrent steps (`Promise.all`): the runtime now waits for detached sibling
  steps to settle before finalising a tick, eliminating stray writes and
  unhandled rejections after the first yield unwinds.
- Terminal transitions are fenced by the instance-lock token (a zombie worker
  that lost a stall takeover can no longer flip state); step-seq allocation
  fails loudly on Redis errors instead of silently reusing `0`; corrupted JSON
  fields report the instance/field instead of an anonymous `SyntaxError`.
- Stall-death settlement: jobs that die without reaching the processor (stalled
  past `maxStalledCount`) or crash mid-settlement are settled by a
  `failed`-event listener — compensation still runs (replay-only forward pass,
  no new side effects).
- NestJS: per-queue stores created by a `durablePrefix` override are closed on
  shutdown (previously leaked their connection).

### Migration (0.1.x → 0.2.0)

Rolling upgrade is supported — no drain needed. In-flight 0.1.x resume jobs
(even ones sleeping for days) are adopted by a built-in shim and continue under
the new mechanics; `cancel()` still finds legacy carriers. Upgrade
`bullmq-cockpit` to 0.2.0 in the same rollout. Remove any `attempts: 1` set on
the old advice. The shim and all deprecated aliases are removed in 0.3.0.

### Removed

- **Dead error exports**: `DurableTimeoutError` (declared since 0.1.x, never
  thrown by anything) and the trivial guards `isYieldError` /
  `isRetryLaterError` / `isDurableControlSignal` — use `instanceof` on the
  classes. All durable-thrown errors except the two BullMQ boundary errors now
  extend `DurableError` (`SettleIncompleteError` and `DurableActionError`
  joined the family), so `err instanceof DurableError` is the one catch-all.

## [0.1.5] - 2026-06-30

### Changed

- NestJS: `@DurableProcess()` no longer takes a job-name argument. The class's
  `@DurableProcessor("queue")` already fixes the queue, so its single
  `@DurableProcess()` method runs every job on the queue — mirroring
  `@nestjs/bullmq`'s `process()`; read `job.name` inside to branch. A processor
  declaring more than one `@DurableProcess()` now throws at startup. **Breaking:**
  migrate `@DurableProcess("video")` to `@DurableProcess()`, collapsing any
  per-name methods into one that switches on `job.name`. (For name-based routing,
  the core `DurableWorker` still accepts a `{ [name]: { run, onFailure } }` map.)

## [0.1.4] - 2026-06-29

### Changed

- NestJS: `@DurableFailure()` no longer takes a job-name argument. One handler per
  `@DurableProcessor` settles every job on the queue — mirroring
  `@OnWorkerEvent('failed')`; read `job.name` inside to branch. A processor
  declaring more than one `@DurableFailure()` now throws at startup. (For per-job
  settlement, the core worker API still accepts a `{ run, onFailure }` handler.)

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
