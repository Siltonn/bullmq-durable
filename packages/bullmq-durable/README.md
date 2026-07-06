# bullmq-durable

**Durable execution for [BullMQ](https://docs.bullmq.io) jobs.** Checkpoint, retry, sleep, and resume long-running jobs with a simple step API.

```ts
new DurableWorker(
  "generation",
  async (job, ctx) => {
    const task = await ctx.step("create-task", () => createTask(job.data))
    await ctx.sleep("wait", "10s")
    return ctx.step("save-result", () => saveResult(task.id))
  },
  { connection },
)
```

`bullmq-durable` does **not** replace BullMQ and is **not** a full workflow engine like Temporal. It adds a thin durable-execution layer on top of BullMQ so a single job can be split into **checkpointed steps** that survive crashes, restarts, and retries. One run rides **one BullMQ job for its whole life** — the job is the run's carrier and scheduler, the durable state is the run's record.

> 💡 **Watch your runs.** [`bullmq-cockpit`](../bullmq-cockpit) is a dashboard that auto-detects
> `bullmq-durable` state in Redis and renders step timelines, durable-aware retry / promote /
> cancel controls, and stuck detection — no extra wiring.

## At a glance

```yaml
package: bullmq-durable
version: 0.2.0
requires: node >=18; bullmq ^5 (peer dependency); Redis (via your BullMQ connection)
install: npm install bullmq-durable bullmq
model: one durable run = one BullMQ job for its whole life; suspensions park that same job via moveToDelayed
instance_id: "${queueName}:${jobId}" # derived, never stored; exposed as job.durableId
retry_model: step errors → per-step retry budget; non-step errors → BullMQ attempts/backoff
state_lifetime: state & logs live exactly as long as the run's job (removeOnComplete/removeOnFail govern; no separate retention config)
logs: job.log() JSON lines tagged "$durable":1, bounded by defaultJobOptions.keepLogs
terminal_semantics: failed job = compensation already ran; job.retry() replays the stored failure; a real re-run is cockpit's durable retry
cancellation: queue.cancel(jobId) # marks the run cancelled and removes its job
key_prefix: bullmq-durable # durablePrefix option; state lives outside job.data, in your Redis
invariants:
  - design steps idempotent — checkpointing memoises results, it is not exactly-once delivery (use ctx.stepId(key) for external side effects)
  - step keys must be deterministic across replays (never timestamps or randomness)
  - compensations (onRollback) run as durable retried steps and must be idempotent
  - ctx.sleep persists the wake-up time before suspending — a crash can never skip the wait
docs: { quick_start: "#quick-start", core_concepts: "#core-concepts", retries: "#retries-two-budgets",
        compensation: "#compensation--failure-handling", state_lifecycle: "#state-follows-the-job",
        redis_persistence: "#redis-persistence", nestjs: "#nestjs", api: "#api",
        migration_from_0_1_x: "#migrating-from-01x", dashboard: ../bullmq-cockpit }
```

> **Tooling note** — dashboards and ops scripts use the same object model as
> application code: **`DurableQueue`** owns the collection (`run` / `getRun` /
> `listRuns` / `listRunsPage` / `countRuns` / `activeRuns` / `summarizeRuns` /
> `reconcile`) and
> **`DurableRun`** is the run entity (`state` / `steps` / `logs` / `events` /
> `summary` / `carrier`, `resume` / `retry` / `retryCompensation` / `cancel` /
> `delete`, legacy-carrier resolution built in) — never read the Redis layout;
> `bullmq-cockpit` is built on exactly this API.

## Table of contents

- **Getting started** — [What is bullmq-durable](#what-is-bullmq-durable) · [Quick start](#quick-start)
- **Core concepts** — [One run, one job](#one-run-one-job) · [Steps: `ctx.step`](#steps-ctxstep) · [Sleeping: `ctx.sleep` / `sleepUntil`](#sleeping-ctxsleep--sleepuntil) · [Polling: `ctx.retryLater`](#polling-ctxretrylater) · [Retries: two budgets](#retries-two-budgets) · [Compensation & failure handling](#compensation--failure-handling) · [Manual retries and re-runs](#manual-retries-and-re-runs)
- **Reliability & operations** — [State follows the job](#state-follows-the-job) · [Logs](#logs) · [Redis persistence](#redis-persistence) · [Production checklist](#production-checklist) · [Limitations](#limitations)
- **Integrations** — [NestJS](#nestjs) · [TypeScript typing](#typescript-typing)
- **Reference** — [API](#api) · [Migrating from 0.1.x](#migrating-from-01x) · [Roadmap](#roadmap)

## Getting started

### What is bullmq-durable

A plain BullMQ worker re-runs the **entire** processor when a job fails:

```
step A success
step B success
step C crash        ──▶  retry: A, B and C all run again
```

For long, side-effectful workflows (charge credits → call a provider → save an asset → send an email)
re-running everything causes double charges, duplicate provider tasks, duplicate emails, and so on.

`bullmq-durable` checkpoints each step:

```
step A success ─▶ checkpoint
step B success ─▶ checkpoint
step C crash        ──▶  retry: A cache hit, B cache hit, C re-runs
```

It provides **durable / resumable / checkpointed execution** — not strong transactions,
exactly-once delivery, or a permanent storage guarantee.

#### Why not BullMQ Flow?

They solve different problems — a BullMQ job stays the unit of work either way; `bullmq-durable`
just lets that one job checkpoint, sleep, retry, and resume internally:

|                   | BullMQ Flow                | bullmq-durable                                |
| ----------------- | -------------------------- | --------------------------------------------- |
| A workflow is…    | many jobs in a DAG         | one job split into durable steps              |
| Unit of execution | the job                    | still the job — one job carries the whole run |
| Best for          | fan-out / fan-in pipelines | long, linear, side-effectful jobs             |

### Quick start

```bash
npm install bullmq-durable bullmq
```

> `bullmq` is a peer dependency, so you install it alongside.

```ts
import { DurableQueue, DurableWorker } from "bullmq-durable"

const connection = { host: "127.0.0.1", port: 6379 }

// 1. A queue — a thin wrapper over BullMQ's Queue.
const queue = new DurableQueue("generation", {
  connection,
  defaultJobOptions: {
    attempts: 3, // non-step errors get BullMQ-native retries (see "Retries: two budgets")
    removeOnComplete: { age: 7 * 24 * 3600 }, // the whole run record lives 7d (see "State follows the job")
    removeOnFail: { age: 30 * 24 * 3600 }, // keep failures longer
    keepLogs: 1000, // bounds ctx.log output (see "Logs")
  },
})

// 2. A worker — the processor receives `(job, ctx)`.
const worker = new DurableWorker(
  "generation",
  async (job, ctx) => {
    const task = await ctx.step("create-video-task", () => createVideoTask(job.data))

    await ctx.sleep("wait-first-poll", "10s")

    const result = await ctx.step(
      "poll-video-result",
      { retry: { attempts: 30, backoff: "10s" } },
      async () => {
        const r = await pollVideoTask(task.id)
        if (r.status !== "completed") throw ctx.retryLater("video still pending")
        return r
      },
    )

    await ctx.step("save-asset", () => saveVideoAsset({ userId: job.data.userId, url: result.url }))
    return result
  },
  { connection },
)

// 3. Enqueue work — identical to BullMQ.
await queue.add("video", { userId, prompt }, { jobId: generationId })
```

The only difference from a plain BullMQ worker is `processor(job)` → `processor(job, ctx)`. While this
runs, you will see **one** job (`generationId`) move `waiting → active → delayed → active → … → completed`:
the sleep and every poll wait happen on that same job.

## Core concepts

### One run, one job

**The job is the run's carrier and scheduler; the durable state is the run's record. One run =
one BullMQ job, from `add()` to the terminal state.**

- **Suspension is native.** Sleeps, step-retry backoffs, and `retryLater` waits park the run's
  *own* job with BullMQ's `moveToDelayed`. There are no auxiliary "resume jobs" and no metadata
  envelope — `job.data` is always your plain payload, and the job you see in any BullMQ UI **is**
  the run, showing as `delayed` while it sleeps.
- **Stable identity.** `instanceId = "${queueName}:${jobId}"` — derived, never stored, unchanged
  for the life of the run. Jobs returned by `queue.add()` (and handed to your processor) carry it
  as `job.durableId`.
- **Tick + replay + checkpoint.** Every delivery replays the processor from the top; completed
  steps are cache hits (no side effects re-run) and execution continues at the first unfinished
  point. Waiting never occupies a worker.
- **Job states map 1:1 to the run:**

| BullMQ job state          | Meaning for the run                                              |
| ------------------------- | ---------------------------------------------------------------- |
| `waiting` / `prioritized` | queued for its next tick                                         |
| `delayed`                 | suspended — sleeping, in a step-retry backoff, or `retryLater`   |
| `active`                  | a tick is executing (replay + the first un-run step)             |
| `completed`               | the run succeeded; `returnvalue` is the processor's output       |
| `failed`                  | terminal failure (compensation already ran) — or cancelled mid-tick |

Because the run is one ordinary job, everything native applies to the whole run: `priority`, `attempts`/`backoff`,
`removeOnComplete`/`removeOnFail`, `keepLogs`, `QueueEvents`, bull-board, and `job.waitUntilFinished()`
(which resolves with the run's real output at true completion). Alongside, the durable state keeps a
finer-grained status (`running` / `yielded` / `compensating` / `completed` / `failed` /
`compensation_failed` / `cancelled`) — what the dashboard renders, and how `compensation_failed` stays
distinguishable even though BullMQ only has `failed`.

### Steps: `ctx.step`

`ctx.step(key, fn)` runs `fn` **at most once** and checkpoints its result. On any later replay, a
completed step returns its cached value without re-running `fn`.

```ts
const task = await ctx.step("create-video-task", async () => {
  return createVideoTask(job.data)
})
```

- If the step already **completed**, the stored result is returned immediately.
- Otherwise `fn` runs; on success the result is checkpointed.
- On failure the step retries (per its [retry policy](#retries-two-budgets)) or triggers the terminal sequence.

**Step results must be JSON-serialisable.** A result is checkpointed by round-tripping through
JSON, so the value you get back — even on the first run — is the JSON form: `Date` becomes a
string, `Map`/`Set` become `{}`, and `undefined` fields disappear. Returning the same shape on
the first run and on replay is deliberate, so code never works once and then breaks after a
resume.

**Keys must be stable across replays.** Use a constant, never a timestamp or random value:

```ts
await ctx.step("create-video-task", ...) // ✅ stable
await ctx.step(`step-${Date.now()}`, ...) // ❌ changes every run
```

#### Idempotency keys

Steps reduce duplicate work but cannot make external side effects atomic. For money/credits/etc.,
use `ctx.stepId(key)` as a business idempotency key:

```ts
await ctx.step("deduct-credits", async () => {
  return db.creditLedger.create({
    userId,
    amount: -240,
    idempotencyKey: ctx.stepId("deduct-credits"), // "generation:{jobId}:deduct-credits"
  })
})
```

### Sleeping: `ctx.sleep` / `sleepUntil`

`ctx.sleep(key, duration)` pauses the run **without occupying a worker**. It checkpoints the
wake-up time and parks the run's own job in BullMQ's delayed set (`moveToDelayed`). When the
delay elapses the job is re-delivered and the replay runs past the sleep.

```ts
await ctx.sleep("wait-provider", "30s")
await ctx.sleepUntil("billing-day", new Date("2026-07-01T00:00:00Z"))
```

The wake-up time is persisted *before* the suspension, so a crash around the sleep can never skip
the wait — an early replay re-parks the job for the rest.

Durations accept a number of milliseconds or a unit string: `ms`, `s`, `m`, `h`, `d`, `w`
(e.g. `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"7d"`).

### Polling: `ctx.retryLater`

`ctx.retryLater(...)` is the idiomatic way to poll a third party. Thrown from inside a step, it
suspends the run and re-runs that step later — without recording a failure (while attempts remain):

```ts
const result = await ctx.step(
  "poll-result",
  { retry: { attempts: 60, backoff: "10s" } },
  async () => {
    const r = await pollTask(task.id)
    if (r.status === "pending") throw ctx.retryLater("still pending")
    if (r.status === "failed") throw ctx.nonRetryable("provider failed") // ⛔ no more retries
    return r
  },
)
```

- `ctx.retryLater("reason")` — reuses the step's retry backoff delay.
- `ctx.retryLater("20s", "reason")` — overrides the delay for this attempt.
- `ctx.nonRetryable("reason")` — fails the run immediately, skipping any remaining attempts.

Unlike a thrown error, `retryLater` is an expected "still pending" signal: by default it keeps
polling **until the step stops throwing it**. Set `retry.attempts` on the step (or via
`defaultStepOptions`) to cap the number of polls — once they are spent, the run fails. Each poll
wait is the run's job sitting in `delayed`; polls consume no job attempts and are not logged.

### Retries: two budgets

A durable run has **two independent retry budgets**, and they cover different failures:

| Budget          | Covers                                                        | Configured by                                  | Consumes                                             |
| --------------- | ------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| **Step retry**  | errors thrown *inside* `ctx.step`                              | the step's `retry` (or `defaultStepOptions`)   | the step's own attempts — job attempts are untouched |
| **Job attempts** | everything else: errors between steps, crashes, stall-deaths | BullMQ's own `attempts` / `backoff` on the job | BullMQ `attemptsMade`                                 |

A **step error** is retried on the step's own budget; the backoff wait is the run's job sitting
in `delayed`, so it never consumes a BullMQ attempt (`attemptsMade` only increments on real job
failures). A **non-step error** — an exception between steps, in glue code — is rethrown to
BullMQ, whose native `attempts` / `backoff` (including a custom `settings.backoffStrategy`)
schedule the re-delivery; replay makes it safe, since only the un-checkpointed tail runs again.

> **Do give jobs real `attempts`.** The 0.1.x docs said to keep BullMQ's `attempts` at `1` — that
> advice is inverted in 0.2.0. Job attempts are now exactly the budget for transient *non-step*
> failures (crashes, OOM kills, bugs between steps); `attempts: 3` with an exponential backoff is
> a sensible default. See [Migrating from 0.1.x](#migrating-from-01x).

The step retry shape mirrors BullMQ's `attempts`/`backoff` vocabulary:

```ts
await ctx.step(
  "generate",
  {
    retry: {
      attempts: 3, // total attempts, including the first (default: 1)
      backoff: { type: "exponential", delay: "10s", jitter: 0.2, maxDelay: "5m" },
    },
  },
  generate,
)
```

`backoff` accepts a **number or duration string** (`5_000`, `"10s"`) for a fixed delay, or an
**object** `{ type, delay, jitter, maxDelay }` — BullMQ's `BackoffOptions` shape, where `type` is
`"fixed" | "exponential"` and `jitter` (0..1) spreads the delay uniformly over
`[delay*(1-jitter), delay)`, exactly like BullMQ. `maxDelay` is a durable extension capping
exponential growth (`delay * 2^(n-1)`); it defaults to **1 hour**, so a forgotten cap can never
park a job absurdly far in the future.

Set worker-wide defaults via `defaultStepOptions`; a step's own options win field-by-field:

```ts
new DurableWorker("generation", processor, {
  connection,
  defaultStepOptions: {
    retry: { attempts: 3, backoff: { type: "exponential", delay: "5s" } },
  },
})
```

The 0.1.x flat retry shape is still accepted and normalised, but deprecated — see
[Migrating from 0.1.x](#migrating-from-01x). When a budget is exhausted (or an error is unrecoverable),
the run enters the terminal sequence — [Compensation & failure handling](#compensation--failure-handling).

### Compensation & failure handling

Durable steps move money, provision resources, call providers. When a later step fails for good,
the work the earlier steps already did has to be undone. Attach a **compensation** to a step with
`onRollback` — it runs, in reverse order, for the steps that actually completed, when the run
reaches a terminal failure:

```ts
const checkout = async (job: DurableJob<CheckoutInput, Receipt>, ctx: DurableContext) => {
  const charge = await ctx.step(
    "charge-card",
    { onRollback: ({ output }) => payments.refund(output.chargeId) },
    () => payments.charge(job.data.cardId, job.data.amount),
  )

  const seat = await ctx.step(
    "reserve-seat",
    { onRollback: ({ output }) => inventory.release(output.seatId) },
    () => inventory.reserve(job.data.seatId),
  )

  // If this fails for good, `reserve-seat` rolls back, then `charge-card`.
  return ctx.step("confirm", () => fulfil(charge, seat))
}
```

A run reaches the terminal sequence when a step's retry budget is exhausted, when `ctx.nonRetryable` /
BullMQ's `UnrecoverableError` is thrown, or when a non-step error burns the **last** job attempt. The
sequence is always: compensation (reverse order) → `onFailure` → the job lands in **`failed`**.

- `onRollback` receives `{ output, error }` — `output` is the step's checkpoint snapshot (the
  same value the step returned), `error` is what triggered the failure.
- Compensations run as **durable, retried steps of their own**, so they survive resumes and must be
  **idempotent** (use `ctx.stepId(key)` as a business idempotency key). A bare function uses the worker's
  `defaultRollbackRetry` (`{ attempts: 5, backoff: { type: "exponential", delay: "1s", maxDelay: "30s" } }`);
  pass `{ handler, retry }` to override it per step.
- The durable state moves through `compensating` while rollbacks run, landing `failed` if they
  all succeed and `compensation_failed` if one can't be completed — **that distinction lives only
  in the durable state and the dashboard**; in BullMQ both are a `failed` job. (This is why you
  should keep failed jobs around — see [State follows the job](#state-follows-the-job).)
- A step with no `onRollback`, and a job with no compensation at all, behave exactly as before:
  straight to `failed`, no compensation phase.

#### Settling a terminal failure

To run final bookkeeping after compensation — mark the order failed, notify the user, emit a metric —
give the job an `onFailure` handler (or set one worker-wide via `DurableWorkerOptions.onFailure`). Use
the `{ run, onFailure }` handler form. It runs **once**, after compensation, for genuine failures only
(`sleep` / `retryLater` / `cancel` never reach it), and its own `ctx.step` calls are durable too:

```ts
const worker = new DurableWorker(
  "orders",
  {
    checkout: {
      run: checkout, // the processor above
      // `failure`: { error, failedStep?, completed, compensation }
      onFailure: async (job, ctx, failure) => {
        await ctx.step("mark-failed", () => orders.markFailed(job.data.orderId))
        await ctx.step("notify", () => email.send(job.data.userId, failure.error))
      },
    },
  },
  { connection },
)
```

#### Stall-death settlement

Two failure paths never get a normal final tick: a job that exceeds `maxStalledCount` is failed by
BullMQ **without** the processor running, and a crash on the last attempt can die mid-compensation.
The worker's `failed`-event listener runs a post-mortem **settlement tick** for these: the forward
phase is replay-only (a half-dead run must not fire new side effects), then compensation and
`onFailure` execute as usual. Settlement runs outside a live job tick, so it cannot suspend —
compensation retries loop in-process there, and **compensation / `onFailure` handlers must not call
`ctx.sleep`**. If settlement itself dies, the instance stays `compensating` with a failed job —
surfaced by the dashboard's stuck detection, recoverable via its retry action.

### Manual retries and re-runs

Because the job *is* the run, BullMQ's own retry buttons and APIs act on it. Their semantics are
deliberate:

| Action                                             | Durable state                       | What happens                                                                                                       |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `job.retry()`                                      | terminal `failed` / `compensation_failed` | Replays the **stored** failure — no business code re-runs, no side effects; the job returns to `failed`.       |
| `job.retry()`                                      | non-terminal (e.g. settlement died) | Legitimate recovery: the run resumes from its checkpoints.                                                          |
| `job.retry("completed")`                           | `completed`                         | Returns the cached output immediately; idempotent no-op.                                                            |
| remove the job, `add()` again with the same `jobId` | —                                   | A **fresh run**: state was reclaimed with the job, so nothing is memoised. The memoization window = the job's lifetime. |
| anything                                           | `cancelled`                         | No-op; the job lands back in `failed`.                                                                              |

To *actually* re-run a failed run's business logic, use
[bullmq-cockpit](../bullmq-cockpit)'s **durable-aware retry**: it resets the failed step's record
and revives the job, so execution continues from the failure point with earlier completed steps
still cached.

The layering: **BullMQ retry is delivery-layer** (safe by replay, never re-fires completed side
effects); **durable retry is business-layer** (re-runs the failed part, and requires that
explicit state operation).

## Reliability & operations

### State follows the job

**A run's durable state (and its logs) live exactly as long as its BullMQ job.** There is no
separate retention configuration: whatever you tell BullMQ about the job governs the whole run
record.

| `removeOnComplete` / `removeOnFail` | Effect on the run record                                   |
| ----------------------------------- | ----------------------------------------------------------- |
| `true`                              | job removed at the terminal state → state reclaimed right away |
| `{ age }` / `{ count }` / a number  | job pruned by BullMQ later → state reclaimed alongside      |
| `false` / unset (BullMQ default)    | job kept forever → state kept forever                       |

Reclamation is observational and **eventually consistent** — there is no event listener and no
real-time promise. The policy:

- **Synchronous** — `DurableQueue.clean()` / `drain()` / `obliterate()` settle durable state in
  the same call (see below).
- **Amortised** — the reaper runs on worker start, after every terminal outcome, on
  durable-state reads, and on an explicit `queue.reconcile()`. Each pass checks a small batch of
  the oldest finished runs for jobs that no longer exist and deletes their state (index-driven,
  never a `SCAN`).
- **External deletions** — if a job is removed directly through BullMQ (`job.remove()`,
  bull-board, a raw `Queue`), its durable state converges at the next reaper trigger. A
  non-terminal orphan is marked `cancelled` once it has been quiet for `reaper.orphanGraceMs`
  (default 10s), then collected.

Bulk queue maintenance stays in sync because `DurableQueue` overrides the three bulk methods as
pass-throughs that also settle durable state:

- `clean(graceMs, limit, type?)` — BullMQ returns the removed job ids, so the matching state is
  deleted exactly.
- `drain(delayed?)` — drain reports nothing, so a reconcile pass follows: non-terminal instances
  whose job vanished are cancelled and reaped.
- `obliterate(opts?)` — wipes **all** durable state for the queue (index-driven, no scan).

The sanctioned way to delete one run is **`queue.cancel(jobId)`** — it marks the run cancelled
(an in-flight tick stops at its next step) and removes the job. Calling `job.remove()` directly
on an in-flight job instead leaves a short-lived orphan that the reconciler auto-cancels
(immediately, with events attached).

> ⚠️ **`removeOnFail: true` erases failure forensics — including `compensation_failed` records**,
> which need a human. If the failed job is deleted the moment it fails, its state and logs go
> with it and the dashboard has nothing to show. Keep failed jobs with an age/count window
> instead (e.g. `removeOnFail: { age: 30 * 24 * 3600 }`); conversely, leaving `removeOnComplete`
> unset keeps **every** finished run forever — set an age/count there too.

> ⚠️ **A sleeping run is a `delayed` job.** Mass operations on the delayed set
> (`clean(0, n, "delayed")`, `drain(true)`) will remove suspended runs — the durable state
> follows correctly (they end up cancelled/reaped), but the runs are gone. Only do this when you
> mean it.

### Logs

`ctx.log(message, meta?)` appends one structured JSON line to the **BullMQ job log**
(`job.log()`), tagged `"$durable": 1` so durable lines coexist with any foreign `job.log()`
output:

```jsonc
{"$durable":1,"kind":"log","timestamp":1719873420000,"message":"charging card",
 "runCount":3,"jobAttempt":1,"step":"charge-card","stepAttempt":2,"meta":{"orderId":"o_1"}}
```

Entries are attributed automatically: `runCount` (which tick), `jobAttempt` (which BullMQ attempt
cycle), and — when emitted inside a step — `step` and `stepAttempt`, plus `phase` for
compensation/failure-phase steps. The runtime also writes `kind: "event"` entries for
failure-path transitions (`step_retry`, `step_failed`, `comp_start`, `comp_step`, `settled`) with
a compact `err` and `retryInMs`. Routine waits (`sleep`, `retryLater` polls) are deliberately not
logged, so they can't crowd out real entries.

Two consequences of living in the job log: **set `defaultJobOptions.keepLogs`** (e.g. `1000`) — BullMQ
only trims the log when it is set, otherwise it grows unbounded — and the logs **share the job's
lifetime**: when the job is pruned, they go with it ([State follows the job](#state-follows-the-job)).

Read them back parsed with `queue.getDurableLogs(jobId)` (returns `[]` once the job is gone), or run
`parseJobLogs(lines)` over any raw job-log listing. Non-durable lines come back as `{ kind: "raw", message }`,
and a `meta` that serialises past 8 KB is replaced with `{ $truncated: true }`. (`parseLogLine`,
`serializeLogEntry`, and `DURABLE_LOG_MARKER` are exported for custom tooling.)

### Redis persistence

> ⚠️ By default, bullmq-durable stores execution state in Redis using the provided BullMQ
> connection. Durability depends on your Redis persistence, replication, backup, and eviction
> policy. For business-critical workflows, enable AOF or provide a custom StateStore.

Durable state lives under a separate key prefix (`bullmq-durable` by default), **not** inside
`job.data`. Recommended production Redis config:

```
appendonly yes
appendfsync everysec
maxmemory-policy noeviction
# plus replication + regular backups (managed Redis is ideal)
```

**Always persist business-critical final state in your own database** (credit ledgers, payments,
subscriptions, asset records, refunds, payouts). Treat the Redis durable state as an execution
checkpoint, not the source of truth.

#### Connections

By default, every `DurableQueue` / `DurableWorker` that isn't given an explicit `stateStore`
opens **its own** `RedisStateStore` (one ioredis connection). A worker opens exactly one (0.2.0
removed the internal resume queue and its extra connection), and a producer-only queue is lazy —
it opens a state connection only when you touch durable state (`getDurableState` /
`getDurableSteps` / `cancel` / `clean` / `obliterate`); `add()` opens none, and `getDurableLogs`
reads via the BullMQ queue, not the store. (BullMQ itself also opens a connection per
`Queue`/`Worker` — a worker's blocking connection can't be shared — so some connections are
inherent to BullMQ.)

If you run **many** durable queues/workers against a connection-limited Redis (Upstash,
ElastiCache), share one store explicitly so they use a single state connection:

```ts
import { DurableQueue, DurableWorker, RedisStateStore } from "bullmq-durable"

const stateStore = new RedisStateStore({ connection })

const queue = new DurableQueue("gen", { connection, stateStore })
new DurableWorker("a", procA, { connection, stateStore })
new DurableWorker("b", procB, { connection, stateStore })
// ↑ N components, one shared state connection
```

The store multiplexes ordinary Redis commands over one socket, so sharing it across many workers
is safe. **In NestJS this is automatic** — `forRoot` builds one shared store and injects it into
every queue and worker it wires up. Pass your own to reuse an existing client (or a
`MemoryStateStore` in tests):

```ts
DurableBullModule.forRoot({ connection, stateStore: myStore })
```

(A `registerQueue` that overrides `durablePrefix` to a different value keeps its own store, since
one store maps to one key prefix — see the shutdown note in [NestJS](#nestjs).)

### Production checklist

- **Redis**: enable AOF, set `maxmemory-policy noeviction`, use replication + backups, and a
  dedicated database/prefix. Monitor memory, delayed jobs, and failed jobs.
- **Cleanup**: set `removeOnComplete` / `removeOnFail` with age/count windows (never
  `removeOnFail: true` — [State follows the job](#state-follows-the-job)) and `keepLogs` in
  `defaultJobOptions`.
- **Job attempts**: give jobs a real `attempts` / `backoff` budget for transient non-step
  failures ([Retries: two budgets](#retries-two-budgets)).
- **Idempotency**: give every external side effect an idempotency key (`ctx.stepId(...)`) and
  write critical final state to your own DB.
- **Step hygiene**: keep step keys stable; don't store huge results in a step; don't perform side
  effects _outside_ a step.
- **Stalls**: tune BullMQ's own `lockDuration` / `stalledInterval` / `maxStalledCount` for your longest
  tick. A run whose job stall-dies is still settled — compensation runs via the `failed`-event listener
  ([Compensation & failure handling](#compensation--failure-handling)). The per-instance durable lock
  is internal (fixed 30s TTL with renewal) and needs no configuration.

### Limitations

- Replay re-runs the processor from the top each tick; **completed steps are cache hits, but the
  surrounding code runs again** — keep non-step code cheap and free of side effects.
- No real distributed transactions / exactly-once semantics — design steps to be idempotent.
- Deduplication by `jobId` lasts as long as the job does: once a run's job is pruned, re-adding
  the same `jobId` starts a fresh run ([Manual retries and re-runs](#manual-retries-and-re-runs)).
- Not yet implemented: `parallel`, `race`, child workflows, external signals/events, and cron
  workflows (see the [Roadmap](#roadmap)).

## Integrations

### NestJS

A NestJS adapter ships behind the `bullmq-durable/nestjs` subpath. It mirrors `@nestjs/bullmq`'s
ergonomics **without depending on it** — `@nestjs/common` and `@nestjs/core` are optional peer
dependencies, so non-NestJS users never install them.

```ts
import { Module } from "@nestjs/common"
import { DurableBullModule } from "bullmq-durable/nestjs"

@Module({
  imports: [
    DurableBullModule.forRoot({ connection }),
    DurableBullModule.registerQueue({
      name: "generation",
      // BullMQ-native options pass through under their own names.
      defaultJobOptions: {
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
        keepLogs: 1000,
      },
      workerOptions: { concurrency: 10 },
      // List the processor here and it is auto-registered — no `providers` entry,
      // so the explorer can never silently miss it.
      processor: GenerationProcessor,
    }),
  ],
  providers: [GenerationService],
})
export class GenerationModule {}
```

Root and per-queue options carry BullMQ's own vocabulary: `prefix`, `defaultJobOptions`, and
`workerOptions` (a sub-object of BullMQ `WorkerOptions` — `concurrency`, `lockDuration`,
`stalledInterval`, `limiter`, …), alongside the durable ones (`durablePrefix`, `stateStore`,
`defaultStepOptions`, `defaultRollbackRetry`). Per-queue values override the root's;
`workerOptions` shallow-merge.

Source `connection` from DI (e.g. a `ConfigService`) with the async forms:

```ts
DurableBullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({ connection: config.get("redis") }),
})
// registerQueueAsync({ name, imports, inject, useFactory }) is the per-queue twin.
```

The decorators are unchanged from 0.1.x. The class's `@DurableProcessor` fixes the queue, so
`@DurableProcess()` takes no argument — like `@nestjs/bullmq`'s single `process()`, it runs every
job on the queue (branch on `job.name` inside if the queue carries several). The handler types
its own payload through `DurableJob<Data, Result>`:

```ts
import { Injectable } from "@nestjs/common"
import {
  DurableProcess, DurableProcessor, InjectDurableQueue,
  type DurableContext, type DurableJob, DurableQueue,
} from "bullmq-durable/nestjs"

@DurableProcessor("generation")
export class GenerationProcessor {
  @DurableProcess()
  async run(
    job: DurableJob<CreateVideoInput, VideoResult>,
    ctx: DurableContext,
  ): Promise<VideoResult> {
    const task = await ctx.step("create-task", () => createVideoTask(job.data))
    await ctx.sleep("wait-first-poll", "10s")
    return ctx.step("save-asset", () => saveVideoAsset(task.id))
  }
}

@Injectable()
export class GenerationService {
  constructor(
    // Payload-typed, exactly like a BullMQ `Queue<Data, Result>`.
    @InjectDurableQueue("generation")
    private readonly queue: DurableQueue<CreateVideoInput, VideoResult>,
  ) {}

  createVideo(input: CreateVideoInput) {
    return this.queue.add("video", input, { jobId: input.generationId })
  }
}
```

`DurableBullModule.forRoot` discovers every `@DurableProcessor` and starts a worker for it
automatically; queue-level options from `registerQueue` override the root defaults.

For [compensation & failure handling](#compensation--failure-handling), add `onRollback` to a
`ctx.step` as usual, and declare the terminal-failure handler with `@DurableFailure()` on a
sibling method of the same `@DurableProcessor`. No job name is needed — like
`@OnWorkerEvent('failed')`, it settles every job on the processor:

```ts
@DurableProcessor("orders")
export class CheckoutProcessor {
  @DurableProcess()
  async run(job: DurableJob<CheckoutInput, Receipt>, ctx: DurableContext) {
    /* … steps with onRollback … */
  }

  @DurableFailure()
  async onFailed(job: DurableJob, ctx: DurableContext, failure: DurableFailureInfo) {
    await ctx.step("mark-failed", () => orders.markFailed(job.data.orderId))
  }
}
```

A processor declares at most one `@DurableFailure()` (branch on `job.name` inside if a multi-job
processor needs to); for finer control, the core worker API still accepts a per-job
`{ run, onFailure }` handler.

**Store ownership & shutdown**: the module tracks every store, queue, and worker it builds —
including the per-queue store created when a `registerQueue` overrides `durablePrefix` — and
closes all of them on shutdown. It implements both `OnModuleDestroy` and
`OnApplicationShutdown`, so connections are released on abnormal shutdown paths too.

See [`examples/nestjs`](./examples/nestjs).

### TypeScript typing

Typing follows BullMQ: the queue is typed by its **payload**, and the job name is a free label
you choose at `add` time — there is no name→payload map to declare.

```ts
const queue = new DurableQueue<CreateVideoInput, VideoResult>("generation", { connection })
await queue.add("video", { userId: "u1", prompt: "hello" }) // ✅ data is type-checked

new DurableWorker("generation", {
  // Each handler types its own payload; the name is just a routing label.
  video: async (job: DurableJob<CreateVideoInput, VideoResult>, ctx) => ({ videoUrl: "..." }),
  image: async (job: DurableJob<CreateImageInput, ImageResult>, ctx) => ({ imageUrl: "..." }),
}, { connection })
```

## Reference

### API

#### `new DurableQueue(name, options)`

`DurableQueueOptions` **extends BullMQ's `QueueOptions`** — every native option (`connection`,
`prefix`, `defaultJobOptions`, …) passes through untouched. On top of that:

| Option           | Type                  | Description                                              |
| ---------------- | --------------------- | -------------------------------------------------------- |
| `stateStore?`    | `StateStore`          | Custom store (defaults to `RedisStateStore`).            |
| `durablePrefix?` | `string`              | Redis key prefix for durable state (`"bullmq-durable"`). |
| `bullmq?`        | `Queue`               | Reuse an existing BullMQ `Queue` (same name) instead of opening one; ownership stays with you — `close()` won't touch it. |
| `reaper?`        | `DurableReaperConfig` | Reaper tuning: `terminalBatchSize` (default 32), `throttleMs` (5s), `orphanGraceMs` (60s). |

Deprecated (warn once, removed in 0.3.0): `bullPrefix` → `prefix`, `resumeAttempts` (ignored).

Methods: `add(name, data, opts?)`, `run(jobId)` / `getRun(jobId)` (vend a `DurableRun`),
`listRuns({ kind, window })` (recency windows), `listRunsPage({ kind, offset, limit, order? })`
(exact zset pages of one terminal bucket — use this for pagination), `countRuns()`,
`activeRuns()`, `summarizeRuns(runs, { stuckThresholdMs })`, `reconcile()`,
`getDurableState(jobId)`, `getDurableSteps(jobId)`, `getDurableLogs(jobId)`, `cancel(jobId)`,
`clean(graceMs, limit, type?)`, `drain(delayed?)`,
`obliterate(opts?)` (state-synced overrides — [State follows the job](#state-follows-the-job)),
`instanceIdFor(jobId)`, `close()`, and `.bullmq` (the underlying BullMQ queue).

#### `new DurableWorker(name, processor, options)`

`processor` takes three forms (see
[Compensation & failure handling](#compensation--failure-handling) for `onFailure`):

```ts
new DurableWorker("q", async (job, ctx) => {...}, opts)            // one function, every job
new DurableWorker("q", { run: processor, onFailure }, opts)        // default handler for the queue
new DurableWorker("q", { video: fn, image: { run, onFailure } }, opts) // per-job-name map
```

The top-level `{ run, onFailure }` form fits the common "one queue = one
workflow" shape, where the job name is just a label and `onFailure` belongs
with the processor. Disambiguation makes `run` a reserved word in the map
form — a worker that really has a job named `"run"` uses the object entry:
`{ run: { run: handleRunJob } }`.

`DurableWorkerOptions` **extends BullMQ's `WorkerOptions`** — `concurrency`, `prefix`,
`lockDuration`, `stalledInterval`, `maxStalledCount`, `limiter`, `settings.backoffStrategy`, …
all pass through untouched. On top of that:

| Option                  | Type                    | Description                                                            |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `stateStore?`           | `StateStore`            | Custom store (defaults to `RedisStateStore`).                          |
| `durablePrefix?`        | `string`                | Redis key prefix for durable state (`"bullmq-durable"`).               |
| `defaultStepOptions?`   | `StepOptions`           | Defaults merged into every `ctx.step` call.                            |
| `defaultRollbackRetry?` | `RetryOptions`          | Retry policy for bare `onRollback` compensations (default `{ attempts: 5, backoff: { type: "exponential", delay: "1s", maxDelay: "30s" } }`). |
| `onFailure?`            | `DurableFailureHandler` | Worker-wide terminal-failure handler for jobs without their own.       |
| `reaper?`               | `DurableReaperConfig`   | Reaper tuning: `terminalBatchSize` (default 32), `throttleMs` (5s), `orphanGraceMs` (60s). |

Deprecated (warn once, removed in 0.3.0): `bullPrefix` → `prefix`, `bullWorkerOptions` → top
level, `lockTimeout` / `retention` / `maxLogs` / `resumeAttempts` (ignored).

Methods: `on(event, listener)`, `waitUntilReady()`, `close()`,
`.worker` (the underlying BullMQ worker), and `.stateStore`.

#### `ctx`

| Member                                               | Description                                              |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `step(key, fn)` / `step(key, options, fn)`           | Run-once, checkpointed work.                              |
| `sleep(key, duration)`                               | Pause for a duration (the job parks as `delayed`).        |
| `sleepUntil(key, date)`                              | Pause until a wall-clock time.                            |
| `retryLater(reason?)` / `retryLater(delay, reason?)` | Re-run this step later.                                   |
| `nonRetryable(reason)`                               | Fail the run immediately.                                 |
| `log(message, meta?)`                                | One structured JSON line in the BullMQ job log ([Logs](#logs)). |
| `stepId(key)`                                        | Deterministic id for a step (idempotency key).            |
| `instanceId` / `runCount`                            | The instance id and current tick count.                   |

Step options (`step(key, options, fn)`): `retry` (per-step retry policy —
[Retries: two budgets](#retries-two-budgets)) and `onRollback` (compensation —
[Compensation & failure handling](#compensation--failure-handling)).

#### Stores

- `RedisStateStore` — default, production.
- `MemoryStateStore` — in-process, for tests.
- Implement the `StateStore` interface for anything else (e.g. Postgres).

The `StateStore` interface changed in 0.2.0 to match the single-job lifecycle:

- **Added**: `beginStep(instanceId, stepKey, init)` — one-round-trip step entry (cancellation
  check + existing-state read + seq allocation + initial `running` write, atomically) — and the
  BullMQ-agnostic reaper primitives `listActive()`, `listOldestTerminal(status, limit)`,
  `removeInstances(ids)`, `wipeAll()` (the worker/queue layer decides *which* jobs are gone; the
  store never talks to BullMQ).
- **Changed**: the terminal transitions (`completeInstance` / `failInstance` /
  `compensationFailedInstance` / `cancelInstance`) take an optional lock token and are fenced — a
  zombie worker whose lock was taken over cannot flip state.
- **Removed**: `appendLog` / `getLogs` (logs live in the job log), `nextResumeSeq` (no resume
  jobs), `expireInstance` (state follows the job).

#### Status index (for the dashboard)

`RedisStateStore` maintains a small secondary index (`{prefix}:idx:*`) so an observer like
[bullmq-cockpit](../bullmq-cockpit) can read per-status counts and the in-flight set **without
scanning** the keyspace. It is additive (it never changes the instance/steps layout), kept in
lock-step with every status transition from the first instance, and reaped together with the
instance state when its job disappears — so there is nothing to configure or run.

### Migrating from 0.1.x

0.2.0 replaces the 0.1.x resume-job machinery (one run = original job + N delayed resume jobs)
with the single-job model of [One run, one job](#one-run-one-job). The upgrade is **rolling — no
drain, no downtime**: a built-in shim adopts in-flight 0.1.x resume jobs (even ones sleeping for
weeks) and converges them onto the new mechanics, and mixed 0.1.x/0.2.0 fleets stay mutually safe
during the rollout. The shim is removed in 0.3.0, so finish the migration within 0.2.x. Upgrade
`bullmq-cockpit` to 0.2.0 in the same deploy.

**Renamed / removed options** (accepted with a one-time deprecation warning; removed in 0.3.0):

| 0.1.x                        | 0.2.0                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `bullPrefix`                 | `prefix` (BullMQ's own option)                                                |
| `bullWorkerOptions: {...}`   | put those fields at the top level — worker options **are** `WorkerOptions`    |
| `lockTimeout`                | ignored — the instance lock is internal; tune `lockDuration`/`stalledInterval` |
| `retention`                  | ignored — state follows the job; use `removeOnComplete`/`removeOnFail` ([State follows the job](#state-follows-the-job)) |
| `maxLogs`                    | ignored — logs live in the job log; bound with `defaultJobOptions.keepLogs`   |
| `resumeAttempts`             | ignored — there are no resume jobs                                            |
| NestJS root `concurrency`    | `workerOptions.concurrency`                                                   |

**Step retry shape** (old flat form still accepted and normalised):

```ts
// 0.1.x
retry: { attempts: 5, backoff: "exponential", delay: "10s", maxDelay: "5m" }
// 0.2.0
retry: { attempts: 5, backoff: { type: "exponential", delay: "10s", maxDelay: "5m" } }
```

**Behavior changes to review:**

- **Remove `attempts: 1`** if you set it on the old docs' advice — job `attempts` are now the
  budget for non-step failures ([Retries: two budgets](#retries-two-budgets)).
- `job.waitUntilFinished()` now resolves at **true completion** with the run's output (0.1.x
  resolved at the first suspension) — an improvement, but callers that relied on the early
  resolve will now wait.
- Any BullMQ UI shows **one job per run** for its whole life (0.1.x showed the original job
  completing early plus transient resume jobs).
- `queue.cancel()` now removes (or fails) the run's job — 0.1.x left a `completed` original job
  behind.
- `job.retry()` on a terminally failed durable job **replays the stored failure** instead of
  re-running business code; real re-runs are a durable-aware dashboard action
  ([Manual retries and re-runs](#manual-retries-and-re-runs)).
- State and logs now share the job's lifetime — configure `removeOnComplete` / `removeOnFail` /
  `keepLogs` where you previously set `retention` / `maxLogs`
  ([State follows the job](#state-follows-the-job), [Logs](#logs)).
- `DurableLog` is a deprecated alias of `DurableLogEntry`; the `message` / `timestamp` / `meta`
  fields are unchanged, so existing readers keep working.

### Roadmap

- `ctx.waitForEvent` + external `queue.sendEvent`
- `ctx.parallel` / `ctx.race`

> Saga compensation (`onRollback`) and terminal-failure settlement (`onFailure`) have shipped —
> see [Compensation & failure handling](#compensation--failure-handling). A read-only dashboard /
> inspection API has shipped too — see [`bullmq-cockpit`](../bullmq-cockpit).

## Development

This repo uses [pnpm](https://pnpm.io) 11, which requires **Node ≥ 22**. (The published library
itself supports Node ≥ 18 at runtime — only the dev toolchain needs 22+.)

```bash
pnpm install
pnpm run build        # tsup -> dist (ESM + CJS + types)
pnpm test             # vitest (Redis-backed tests auto-skip without Redis)
pnpm run typecheck    # tsc, including the compile-time type tests
pnpm run lint
pnpm run format:check
```

The unit suite runs entirely on the in-memory store. Set `REDIS_HOST` / `REDIS_PORT` to run the
Redis integration tests as well — CI runs them against a Redis service automatically.

## License

[MIT](./LICENSE)
