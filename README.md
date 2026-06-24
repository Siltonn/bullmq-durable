# bullmq-durable

**Durable execution for [BullMQ](https://docs.bullmq.io) jobs.** Checkpoint, retry, sleep, and resume long-running jobs with a simple step API.

```ts
new DurableWorker("generation", async (job, ctx) => {
  const task = await ctx.step("create-task", () => createTask(job.data))
  await ctx.sleep("wait", "10s")
  return ctx.step("save-result", () => saveResult(task.id))
}, { connection })
```

`bullmq-durable` does **not** replace BullMQ and is **not** a full workflow engine like Temporal. It adds a thin durable-execution layer on top of BullMQ so a single job can be split into **checkpointed steps** that survive crashes, restarts, and retries.

---

## Table of contents

1. [What is bullmq-durable?](#1-what-is-bullmq-durable)
2. [Why not BullMQ Flow?](#2-why-not-bullmq-flow)
3. [Quick start](#3-quick-start)
4. [`ctx.step`](#4-ctxstep)
5. [`ctx.sleep`](#5-ctxsleep)
6. [`ctx.retryLater`](#6-ctxretrylater)
7. [Retry policy](#7-retry-policy)
8. [Redis persistence ⚠️](#8-redis-persistence-)
9. [NestJS integration](#9-nestjs-integration)
10. [TypeScript job map](#10-typescript-job-map)
11. [Production checklist](#11-production-checklist)
12. [Limitations](#12-limitations)
13. [Roadmap](#13-roadmap)
14. [API reference](#14-api-reference)

---

## 1. What is bullmq-durable?

A plain BullMQ worker re-runs the **entire** processor when a job fails:

```
step A success
step B success
step C crash        ──▶  retry: A, B and C all run again
```

For long, side-effectful workflows (charge credits → call a provider → save an
asset → send an email) re-running everything causes double charges, duplicate
provider tasks, duplicate emails, and so on.

`bullmq-durable` checkpoints each step:

```
step A success ─▶ checkpoint
step B success ─▶ checkpoint
step C crash        ──▶  resume: A cache hit, B cache hit, C re-runs
```

It provides **durable / resumable / checkpointed execution** — not strong
transactions, exactly-once delivery, or a permanent storage guarantee.

## 2. Why not BullMQ Flow?

They solve different problems:

| | BullMQ Flow | bullmq-durable |
| --- | --- | --- |
| A workflow is… | many jobs in a DAG | one job split into durable steps |
| Unit of execution | the job | the **durable instance** (survives resumes) |
| Best for | fan-out / fan-in pipelines | long, linear, side-effectful jobs |

A BullMQ job is still the unit of work — `bullmq-durable` just lets that one job
checkpoint, sleep, retry, and resume internally.

## 3. Quick start

```bash
npm install bullmq-durable bullmq
```

> `bullmq` is a peer dependency, so you install it alongside.

```ts
import { DurableQueue, DurableWorker } from "bullmq-durable"

const connection = { host: "127.0.0.1", port: 6379 }

// 1. A queue — a thin wrapper over BullMQ's Queue.
const queue = new DurableQueue("generation", { connection })

// 2. A worker — the processor receives `(job, ctx)`.
const worker = new DurableWorker(
  "generation",
  async (job, ctx) => {
    const task = await ctx.step("create-video-task", () => createVideoTask(job.data))

    await ctx.sleep("wait-first-poll", "10s")

    const result = await ctx.step(
      "poll-video-result",
      { retry: { attempts: 30, backoff: "fixed", delay: "10s" } },
      async () => {
        const r = await pollVideoTask(task.id)
        if (r.status !== "completed") throw ctx.retryLater("video still pending")
        return r
      },
    )

    await ctx.step("save-asset", () => saveVideoAsset({ userId: job.data.userId, url: result.url }))
    return result
  },
  { connection, retention: { completed: "7d", failed: "30d" } },
)

// 3. Enqueue work — identical to BullMQ.
await queue.add("video", { userId, prompt }, { jobId: generationId })
```

The only difference from a plain BullMQ worker is `processor(job)` →
`processor(job, ctx)`.

## 4. `ctx.step`

`ctx.step(key, fn)` runs `fn` **at most once** and checkpoints its result. On any
later replay, a completed step returns its cached value without re-running `fn`.

```ts
const task = await ctx.step("create-video-task", async () => {
  return createVideoTask(job.data)
})
```

- If the step already **completed**, the stored result is returned immediately.
- Otherwise `fn` runs; on success the result is checkpointed.
- On failure the step retries (per its [retry policy](#7-retry-policy)) or fails the instance.

**Step results must be JSON-serialisable.** A result is checkpointed by
round-tripping through JSON, so the value you get back — even on the first run —
is the JSON form: `Date` becomes a string, `Map`/`Set` become `{}`, and
`undefined` fields disappear. Returning the same shape on the first run and on
replay is deliberate, so code never works once and then breaks after a resume.

**Keys must be stable across replays.** Use a constant, never a timestamp or
random value:

```ts
await ctx.step("create-video-task", ...) // ✅ stable
await ctx.step(`step-${Date.now()}`, ...) // ❌ changes every run
```

### Idempotency keys

Steps reduce duplicate work but cannot make external side effects atomic. For
money/credits/etc., use `ctx.stepId(key)` as a business idempotency key:

```ts
await ctx.step("deduct-credits", async () => {
  return db.creditLedger.create({
    userId,
    amount: -240,
    idempotencyKey: ctx.stepId("deduct-credits"), // "generation:{id}:deduct-credits"
  })
})
```

## 5. `ctx.sleep`

`ctx.sleep(key, duration)` pauses the instance **without occupying a worker**. It
records a checkpoint, schedules a delayed resume, and yields. When the delay
elapses the job is re-delivered and replays past the sleep.

```ts
await ctx.sleep("wait-provider", "30s")
await ctx.sleepUntil("billing-day", new Date("2026-07-01T00:00:00Z"))
```

Durations accept a number of milliseconds or a unit string: `ms`, `s`, `m`, `h`,
`d`, `w` (e.g. `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"7d"`).

## 6. `ctx.retryLater`

`ctx.retryLater(...)` is the idiomatic way to poll a third party. Thrown from
inside a step, it schedules a resume and re-runs that step later — without
recording a failure (while attempts remain):

```ts
const result = await ctx.step(
  "poll-result",
  { retry: { attempts: 60, delay: "10s" } },
  async () => {
    const r = await pollTask(task.id)
    if (r.status === "pending") throw ctx.retryLater("still pending")
    if (r.status === "failed") throw ctx.nonRetryable("provider failed") // ⛔ no more retries
    return r
  },
)
```

- `ctx.retryLater("reason")` — reuses the step's retry `delay`.
- `ctx.retryLater("20s", "reason")` — overrides the delay for this attempt.
- `ctx.nonRetryable("reason")` — fails the instance immediately, skipping any
  remaining attempts.

Unlike a thrown error, `retryLater` is an expected "still pending" signal: by
default it keeps polling **until the step stops throwing it**. Set
`retry.attempts` on the step (or via `defaultStepOptions`) to cap the number of
polls — once they are spent, the instance fails.

## 7. Retry policy

Each step has an independent retry policy (this is **step-level** retry, distinct
from BullMQ's job-level `attempts`):

```ts
await ctx.step("generate", {
  retry: {
    attempts: 3,            // total attempts, including the first (default: 1)
    backoff: "exponential", // "fixed" | "exponential" (default: "fixed")
    delay: "10s",           // base delay (default: 0)
    maxDelay: "5m",         // optional cap for exponential backoff
  },
}, generate)
```

Backoff before the *n*-th retry:

- `fixed` → `delay`
- `exponential` → `delay * 2^(n-1)`, capped at `maxDelay` (which defaults to a
  1-hour ceiling, so the delay can never run away to `Infinity`)

Set worker-wide defaults via `defaultStepOptions`; a step's own options win:

```ts
new DurableWorker("generation", processor, {
  connection,
  defaultStepOptions: { retry: { attempts: 3, backoff: "exponential", delay: "5s" } },
})
```

Because retries are driven by delayed resume jobs, keep BullMQ's own `attempts`
at `1` (the default) and let `ctx.step` own retries.

## 8. Redis persistence ⚠️

> By default, bullmq-durable stores execution state in Redis using the provided
> BullMQ connection. Durability depends on your Redis persistence, replication,
> backup, and eviction policy. For business-critical workflows, enable AOF or
> provide a custom StateStore.

Durable state lives under a separate key prefix (`bullmq-durable` by default),
**not** inside `job.data`. Recommended production Redis config:

```
appendonly yes
appendfsync everysec
maxmemory-policy noeviction
# plus replication + regular backups (managed Redis is ideal)
```

**Always persist business-critical final state in your own database** (credit
ledgers, payments, subscriptions, asset records, refunds, payouts). Treat the
Redis durable state as an execution checkpoint, not the source of truth.

## 9. NestJS integration

A NestJS adapter ships behind the `bullmq-durable/nestjs` subpath. It mirrors
`@nestjs/bullmq`'s ergonomics **without depending on it** — `@nestjs/common` and
`@nestjs/core` are optional peer dependencies, so non-NestJS users never install
them.

```ts
import { Module } from "@nestjs/common"
import { DurableBullModule } from "bullmq-durable/nestjs"

@Module({
  imports: [
    DurableBullModule.forRoot({ connection }),
    DurableBullModule.registerQueue({
      name: "generation",
      retention: { completed: "7d", failed: "30d" },
    }),
  ],
  providers: [GenerationProcessor, GenerationService],
})
export class GenerationModule {}
```

```ts
import { Injectable } from "@nestjs/common"
import {
  DurableProcess,
  DurableProcessor,
  InjectDurableQueue,
  type DurableContext,
  type DurableJob,
  DurableQueue,
} from "bullmq-durable/nestjs"

@DurableProcessor("generation")
export class GenerationProcessor {
  @DurableProcess("video")
  async run(job: DurableJob<CreateVideoInput, VideoResult>, ctx: DurableContext): Promise<VideoResult> {
    const task = await ctx.step("create-task", () => createVideoTask(job.data))
    await ctx.sleep("wait-first-poll", "10s")
    return ctx.step("save-asset", () => saveVideoAsset(task.id))
  }
}

@Injectable()
export class GenerationService {
  constructor(@InjectDurableQueue("generation") private readonly queue: DurableQueue<GenerationJobs>) {}

  createVideo(input: CreateVideoInput) {
    return this.queue.add("video", input, { jobId: input.generationId })
  }
}
```

`DurableBullModule.forRoot` discovers every `@DurableProcessor` and starts a
worker for it automatically; queue-level options from `registerQueue` override
the root defaults.

See [`examples/nestjs`](./examples/nestjs).

## 10. TypeScript job map

Describe your jobs once and get end-to-end inference on `queue.add` and worker
handlers:

```ts
type GenerationJobs = {
  video: { data: CreateVideoInput; result: VideoResult }
  image: { data: CreateImageInput; result: ImageResult }
}

const queue = new DurableQueue<GenerationJobs>("generation", { connection })
await queue.add("video", { userId: "u1", prompt: "hello" }) // ✅ data is type-checked

new DurableWorker<GenerationJobs>(
  "generation",
  {
    video: async (job, ctx) => ({ videoUrl: "..." }), // job.data: CreateVideoInput
    image: async (job, ctx) => ({ imageUrl: "..." }),
  },
  { connection },
)
```

## 11. Production checklist

- **Redis**: enable AOF, set `maxmemory-policy noeviction`, use replication +
  backups, and a dedicated database/prefix. Monitor memory, delayed jobs, and
  failed instances.
- **Idempotency**: give every external side effect an idempotency key
  (`ctx.stepId(...)`) and write critical final state to your own DB.
- **Step hygiene**: keep step keys stable; don't store huge results in a step;
  don't perform side effects *outside* a step.
- **Concurrency**: a per-instance lock (default TTL `5m`) prevents two workers
  from advancing the same instance at once. Tune `lockTimeout` to comfortably
  exceed your longest single tick.

```ts
new DurableWorker("generation", processor, {
  connection,
  concurrency: 10,
  lockTimeout: "5m",
  retention: { completed: "7d", failed: "30d" },
  defaultStepOptions: { retry: { attempts: 3, backoff: "exponential", delay: "5s" } },
})
```

## 12. Limitations

- Replay re-runs the processor from the top each tick; **completed steps are
  cache hits, but the surrounding code runs again** — keep non-step code cheap
  and free of side effects.
- No real distributed transactions / exactly-once semantics — design steps to be
  idempotent.
- Resume ticks appear as additional jobs in BullMQ's UI (the durable instance id
  stays stable across them).
- Not yet implemented: `parallel`, `race`, child workflows, external
  signals/events, cron workflows, and Saga compensation (see the roadmap).

## 13. Roadmap

- `ctx.waitForEvent` + external `queue.sendEvent`
- `ctx.parallel` / `ctx.race`
- Step compensation (`compensate`) for Saga-style rollbacks
- A read-only dashboard / inspection API

## 14. API reference

### `new DurableQueue(name, options)`

| Option | Type | Description |
| --- | --- | --- |
| `connection` | `ConnectionOptions` | BullMQ/ioredis connection. |
| `stateStore?` | `StateStore` | Custom store (defaults to `RedisStateStore`). |
| `durablePrefix?` | `string` | Redis key prefix for durable state (`"bullmq-durable"`). |
| `bullPrefix?` | `string` | BullMQ's own key prefix. |
| `defaultJobOptions?` | `JobsOptions` | Default BullMQ job options. |

Methods: `add(name, data, opts?)`, `getDurableState(jobId)`,
`getDurableSteps(jobId)`, `getDurableLogs(jobId)`, `cancel(jobId)`, `close()`,
and `.bull` (the underlying BullMQ queue).

### `new DurableWorker(name, processor, options)`

`processor` is either a single `(job, ctx) => result` function or a
`{ [jobName]: handler }` map. Options add `concurrency`, `lockTimeout`,
`retention`, `defaultStepOptions`, `maxLogs`, `resumeAttempts`, `stateStore`,
`durablePrefix`, and `bullWorkerOptions` on top of `connection`.

`resumeAttempts` (default `3`) is the BullMQ `attempts` given to internally
scheduled resume ticks, so a transient failure to enqueue the next resume is
retried rather than stranding the instance.

### `ctx`

| Member | Description |
| --- | --- |
| `step(key, fn)` / `step(key, options, fn)` | Run-once, checkpointed work. |
| `sleep(key, duration)` | Pause for a duration. |
| `sleepUntil(key, date)` | Pause until a wall-clock time. |
| `retryLater(reason?)` / `retryLater(delay, reason?)` | Re-run this step later. |
| `nonRetryable(reason)` | Fail the instance immediately. |
| `log(message, meta?)` | Append a structured log (mirrored to the BullMQ job). |
| `stepId(key)` | Deterministic id for a step (idempotency key). |
| `instanceId` / `runCount` | The instance id and current run count. |

### Stores

- `RedisStateStore` — default, production.
- `MemoryStateStore` — in-process, for tests.
- Implement the `StateStore` interface for anything else (e.g. Postgres).

---

## Development

This repo uses [pnpm](https://pnpm.io) 11, which requires **Node ≥ 22**. (The
published library itself supports Node ≥ 18 at runtime — only the dev toolchain
needs 22+.)

```bash
pnpm install
pnpm run build        # tsup -> dist (ESM + CJS + types)
pnpm test             # vitest (Redis-backed tests auto-skip without Redis)
pnpm run typecheck    # tsc, including the compile-time type tests
pnpm run lint
pnpm run format:check
```

The unit suite runs entirely on the in-memory store. Set `REDIS_HOST` /
`REDIS_PORT` to run the Redis integration tests as well — CI runs them against a
Redis service automatically.

## License

[MIT](./LICENSE)
