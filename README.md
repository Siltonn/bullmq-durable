# bullmq-durable

**Durable execution for [BullMQ](https://docs.bullmq.io/) jobs — plus a modern dashboard to watch them run.**

This monorepo ships two independent, separately-published packages:

| Package | What it is |
| ------- | ---------- |
| [**`bullmq-durable`**](packages/bullmq-durable) | A thin durable-execution layer for BullMQ workers: split one job into **checkpointed steps** that survive crashes, restarts, and retries — with `sleep`, `retryLater`, and per-step retry policies. Dependency-light, drop-in. |
| [**`bullmq-cockpit`**](packages/bullmq-cockpit) | An embeddable, framework-agnostic **dashboard** for any BullMQ deployment — queues, jobs, flows, schedulers, metrics, alerts — that lights up a first-class **durable inspector** when it finds `bullmq-durable` state in Redis. |

[![BullMQ Cockpit — the dashboard Overview](packages/bullmq-cockpit/docs/overview.png)](packages/bullmq-cockpit)

They're built to be used together but ship apart:

- **`bullmq-durable`** is a small runtime you add to your workers — no dashboard required.
- **`bullmq-cockpit`** works against **plain BullMQ** out of the box, and auto-detects `bullmq-durable` to add step timelines, sleep / retry / resume controls, and stuck detection.

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

To try the cockpit against demo data, one command brings up a throwaway Redis, seeds it, and starts the dev server:

```bash
pnpm --filter bullmq-cockpit demo   # redis + seed + dev → http://localhost:3010
```

## Read more

- [**bullmq-durable**](packages/bullmq-durable) — the step API (`ctx.step` / `sleep` / `retryLater`), retry policy, Redis persistence, NestJS integration, and the production checklist.
- [**bullmq-cockpit**](packages/bullmq-cockpit) — features, embedding (Express / Fastify / NestJS / Hono), auth & permissions, the HTTP API, and local development.

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
