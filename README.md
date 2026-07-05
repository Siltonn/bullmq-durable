# bullmq-durable

**Durable execution for [BullMQ](https://docs.bullmq.io/) jobs — plus a modern dashboard to watch them run.**

## At a glance

```yaml
monorepo: two independent, separately-published packages (versioned in lockstep)
packages:
  bullmq-durable: # runtime — durable execution layer for BullMQ workers
    what: checkpointed steps, sleep, retryLater, per-step retries, saga compensation
    model: one durable run = ONE BullMQ job for its whole life (native moveToDelayed)
    docs: packages/bullmq-durable/README.md
  bullmq-cockpit: # dashboard — embeddable admin UI for any BullMQ deployment
    what: queues/jobs/flows/schedulers/metrics/alerts + a durable inspector
    works-without-durable: yes (plain BullMQ is first-class; durable auto-detected)
    docs: packages/bullmq-cockpit/README.md
requires: node >=18 (runtime) / >=22 + pnpm 11 (this workspace), bullmq ^5, redis
key-facts:
  - the packages never import each other; the cockpit reads a documented Redis protocol
  - BullMQ options (attempts/backoff/removeOnComplete/keepLogs/…) govern a whole durable run
  - durable state & logs live exactly as long as the run's job — no separate retention config
architecture-decisions: studio-rfc.md (historical), packages/bullmq-cockpit/ARCHITECTURE.md
```

| Package | What it is |
| ------- | ---------- |
| [**`bullmq-durable`**](packages/bullmq-durable) | A thin durable-execution layer for BullMQ workers: split one job into **checkpointed steps** that survive crashes, restarts, and retries — with `sleep`, `retryLater`, per-step retry policies, and saga compensation. Dependency-light, drop-in. |
| [**`bullmq-cockpit`**](packages/bullmq-cockpit) | An embeddable, framework-agnostic **dashboard** for any BullMQ deployment — queues, jobs, flows, schedulers, metrics, alerts — that lights up a first-class **durable inspector** when it finds `bullmq-durable` state in Redis. |

[![BullMQ Cockpit — the dashboard Overview](packages/bullmq-cockpit/docs/overview.png)](packages/bullmq-cockpit)

## How the two fit together

```
 your app ──▶ DurableQueue.add(name, data)          bullmq-cockpit (dashboard)
                     │                                    │  reads Redis directly:
                     ▼                                    │  bull:* (BullMQ keys)
              ONE BullMQ job  ◀───── moveToDelayed ──┐    │  bullmq-durable:* (state)
                     │                               │    ▼
              DurableWorker ── ctx.step / sleep ─────┘   never imports the runtime
                     │
              checkpoints in Redis (replayed on every re-delivery)
```

They're built to be used together but ship apart:

- **`bullmq-durable`** is a small runtime you add to your workers — no dashboard required.
- **`bullmq-cockpit`** works against **plain BullMQ** out of the box, and auto-detects
  `bullmq-durable` to add step timelines, attributed logs, compensation views,
  resume/retry/cancel controls, and stuck detection.

## Try it in two minutes

Durable worker (see the [full quick start](packages/bullmq-durable#quick-start)):

```ts
import { DurableQueue, DurableWorker } from "bullmq-durable"

const worker = new DurableWorker("emails", {
  welcome: async (job, ctx) => {
    const user = await ctx.step("load-user", () => loadUser(job.data.userId))
    await ctx.sleep("cool-down", "5s") // the job parks itself; no worker held
    await ctx.step("send", () => sendEmail(user.email))
    return { sent: true }
  },
}, { connection })
```

Dashboard against any BullMQ Redis (no durable required):

```bash
npx bullmq-cockpit --redis redis://localhost:6379
```

Or the full local demo — throwaway Redis, seeded data, dev server:

```bash
pnpm --filter bullmq-cockpit demo   # redis + seed + dev → http://localhost:3010
```

## Layout

```
packages/
├─ bullmq-durable/   # runtime   → published as `bullmq-durable`
└─ bullmq-cockpit/   # dashboard → published as `bullmq-cockpit`
```

## Development

Requires [pnpm](https://pnpm.io) 11 (Node ≥ 22 for the toolchain; the published `bullmq-durable` runtime supports Node ≥ 18).

```bash
pnpm install            # install the whole workspace
pnpm -r run build       # build every package
pnpm -r run typecheck   # type-check every package
pnpm -r run test        # test every package (some suites need a local Redis)
```

Per-package work runs through pnpm filters:

```bash
pnpm --filter bullmq-durable test
pnpm --filter bullmq-cockpit dev
```

## Releasing

Both packages are versioned **in lockstep**. To cut a release: bump the version in
`packages/bullmq-durable/package.json`, `packages/bullmq-cockpit/package.json`, and
`COCKPIT_VERSION` (`packages/bullmq-cockpit/src/server/options.ts`); add a dated
section to each `CHANGELOG.md`; then publish from a clean `main`:

```bash
pnpm run publish:dry       # preview both tarballs (any branch — skips git checks)
pnpm run publish:all       # build + publish both (durable first, then cockpit)
pnpm run publish:durable   # …or publish just one
pnpm run publish:cockpit
```

Each package builds itself via `prepublishOnly`. The `publish:durable` / `publish:cockpit`
/ `publish:all` scripts run pnpm's git checks (clean working tree, on the publish
branch) — append `--no-git-checks` to override. Publishing requires npm auth
(`npm login`, or an `NPM_TOKEN` in CI).

## License

MIT
