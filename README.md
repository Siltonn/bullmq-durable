# bullmq-durable monorepo

Durable execution for [BullMQ](https://docs.bullmq.io/) jobs, plus a modern
dashboard and durable-instance inspector.

| Package                                              | What it is                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`bullmq-durable`](packages/bullmq-durable)          | Runtime add-on: checkpoint, retry, sleep, and resume long-running jobs with a simple step API. |
| [`bullmq-cockpit`](packages/bullmq-cockpit)            | Embeddable dashboard for any BullMQ deployment, with a first-class durable-instance inspector. |

The two packages are independent npm releases that share a monorepo:

- `bullmq-durable` is a small, dependency-light runtime you add to your workers.
- `bullmq-cockpit` is a heavier React/Hono dashboard. It works against **plain
  BullMQ** out of the box, and automatically lights up the durable inspector
  when it detects `bullmq-durable` state in Redis.

## Layout

```
packages/
├─ bullmq-durable/   # runtime (published as `bullmq-durable`)
└─ bullmq-cockpit/    # dashboard (published as `bullmq-cockpit`)
```

## Development

```bash
pnpm install          # install the whole workspace
pnpm -r run build     # build every package
pnpm -r run typecheck # type-check every package
pnpm -r run test      # test every package (needs a local Redis for some suites)
```

Per-package scripts run through pnpm filters:

```bash
pnpm --filter bullmq-durable test
pnpm --filter bullmq-cockpit dev
```

To try the cockpit against demo data, one command brings up a throwaway Redis,
seeds it, and starts the dev server:

```bash
pnpm --filter bullmq-cockpit demo   # redis + seed + dev → http://localhost:3010
```

See [packages/bullmq-cockpit](packages/bullmq-cockpit#local-development) for the
step-by-step flow and how to point it at your own Redis.

## License

MIT
