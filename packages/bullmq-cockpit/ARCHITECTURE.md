# bullmq-cockpit — Architecture & Code Organization

This document is the **map** for how the package is structured and the **target
layout** we are migrating toward. When in doubt about where a file belongs,
follow the decision guide below rather than copying whatever is nearest.

> Status: **migration complete** — every step in the [Migration](#migration)
> section has landed (each verified with `typecheck` + `lint` + `build`). The
> tree below now reflects the actual layout; keep it in sync as the code evolves.

---

## Big picture

`bullmq-cockpit` is **one publishable package that ships two builds**:

|            | Source    | Built by | Output                                | Runtime |
| ---------- | --------- | -------- | ------------------------------------- | ------- |
| **Server** | `src/`    | tsup     | `dist/` (the npm library + CLI)       | Node    |
| **Client** | `client/` | Vite     | `dist/client/` (static SPA, embedded) | Browser |

They are **siblings, not nested**, because they are two different compilation
targets with incompatible TypeScript environments (Node vs DOM/JSX) and two
different bundlers. The server is a framework-agnostic Hono app
(`createCockpitApp`) that every adapter (`express` / `fastify` / `nestjs` /
`standalone`) wraps; the client is a feature-sliced React SPA the server serves.

---

## Principles

1. **One file, one cohesive concern.** Split god-files along their natural seams
   (the section comments usually already mark them). Rule of thumb: if a file is
   past ~300 lines _and_ covers more than one responsibility, split it.
2. **Co-locate by domain; lift only the truly shared.** A component / type /
   constant used by **one** feature lives in that feature. Only things used
   across features go up to a shared layer (`components/ui`, `lib`).
3. **Separate by level.** Keep distinct levels in distinct places:
   - types: wire contract ↔ server-internal ↔ client view
   - client UI: generic primitives ↔ app chrome ↔ feature components
   - inside a feature: pages ↔ components ↔ config
4. **Keep the public surface stable.** The adapters, `src/index.ts`,
   `@shared/dto`, and each feature's `index.ts` are public seams. Re-export
   through barrels so refactors stay **internal, mechanical, and
   zero-behavior-change** — every step must pass `typecheck` + `build`.

---

## Type levels

Three levels, three homes — never mix them in one file:

| Level                                                                  | Lives in                          | Notes                                                                           |
| ---------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| **Wire contract** (client↔server API shapes)                           | `src/shared/dto/<domain>.ts`      | The only types shared by both builds. Split per domain, re-export via a barrel. |
| **Server-internal** (`JobListQuery`, `CleanOptions`, options, context) | next to the module that owns them | Not part of the wire contract.                                                  |
| **Client view / props**                                                | next to the component             | Inline or a feature-local `types.ts`.                                           |

**Anchor to the library, don't hand-roll.** Where BullMQ owns a type, derive
from it (`… as const satisfies readonly JobType[]`,
`Parameters<Queue["clean"]>[2]`) so a future BullMQ change fails at compile time
instead of drifting silently. The wire DTOs in `src/shared` are the deliberate
exception (the client bundle can't import `bullmq`).

---

## Server — `src/`

```
src/
  index.ts                     public entry (re-exports the core + types)
  shared/
    dto/                       ← the wire contract, split per domain + barrel
      index.ts                 re-exports everything (so `@shared/dto` is unchanged)
      common.ts                SerializedError · Paginated · ActionResult
      auth.ts                  BoardPermission · BoardUser · CockpitConfig
      jobs.ts                  JobCounts · JobState · JobSummary/Detail · JobLogs · Dependencies
      queues.ts                QueueSummary · QueueDetail
      durable.ts               Durable* (Step / Instance / Event / status unions)
      health.ts                DurableStatusCounts · OverviewStats · Stuck* · Health
      schedulers.ts
      metrics.ts               MetricPoint/Series · QueueMetrics
      signals.ts               Latency/Activity/JobNameStat · QueueActivity · QueueSignal · SystemSignals · RedisInfo
      flows.ts                 FlowNode · JobFlow · FlowSummary
      alerts.ts                Alert*
  server/
    app.ts                     composition: build the Hono app, mount routes
    context.ts                 the board context (DI container; owns connections + inspectors)
    options.ts                 option normalization
    client.ts                  serve the built SPA
    middleware/                auth.ts (cross-cutting request middleware)
    http/                      http-error.ts · validate.ts · contracts.ts
    infra/                     redis.ts · util/preview.ts (low-level helpers)
    routes/                    one file per domain (already split — keep)
    durable/                   protocol.ts · derive.ts (durable Redis protocol, mirrored)
    inspectors/
      bullmq/                  ← split of the old 966-line bullmq-inspector
        queue-inspector.ts     queues: names/summary/detail · pause/resume/drain/clean · counts · workers
        job-inspector.ts       jobs: list/get/logs/deps · add · retry/promote/remove/duplicate · bulk
        scheduler-inspector.ts repeatable / cron jobs
        metrics-inspector.ts   getMetrics + golden-signals derivation (activity / latency / systemSignals)
        flow-inspector.ts      parent↔children flow trees
        redis-inspector.ts     Redis INFO
        shared.ts              cross-inspector helpers: job-key parsing · queue discovery · ALL_JOB_TYPES
      durable-inspector.ts     (exists)
      health-inspector.ts      (exists)
      alerts-inspector.ts      (exists — large; split later if it keeps growing)
  adapters/                    express · fastify · nestjs · standalone · node-bridge
  cli/                         the `bullmq-cockpit` binary
```

**Notes**

- The `server/` sub-folders (`middleware/`, `http/`, `infra/`) group the root by
  level. This was done last — it churned the most import paths for the least
  gain, but keeps the root to just the composition files (`app` · `context` ·
  `options` · `client`) plus the level-folders.
- Each `bullmq/*-inspector.ts` takes the board context (or `getQueue`) as a dep
  and stays ~120–200 lines. Domain helpers move with their inspector
  (`normalizeScheduler` → scheduler, `buildActivity` → metrics,
  `parseRedisInfo` → redis); only genuinely cross-cutting helpers go in
  `bullmq/shared.ts`.

---

## Client — `client/src/`

```
client/src/
  main.tsx · router.tsx
  components/
    ui/         generic primitives, no domain knowledge:
                states · page-header · copy-button · relative-time · json-viewer ·
                pagination-bar · data-table · status-badge · composition-bar ·
                metric-card · confirm-dialog · action-menu · queue-picker · time-zone-picker
    layout/     app chrome: app-shell · sidebar · topbar · command-menu · logo
    charts/     (exists) donut · bar-list · throughput · chart-tooltip · queue-bar-chart
  lib/
    *.ts        pure utils: format · search · base-path · use-now
    api/        api.ts · query.ts (data layer)
    providers/  React context/state: config · theme · time · toast · confirm · actions
    tokens.ts   design tokens / status→class maps (see "Where config goes")
    icons.tsx · chart.ts · status.ts   (token-level mappings; may move under tokens/ later)
  features/<feature>/
    index.ts    the ONLY file at the root — the feature's PUBLIC API. Re-exports
                its page components (for the router) + any component other
                features may use. Everything else lives in a sub-folder.
    pages/      route screens — one file per page (list / detail / …)
    components/ business components shared across this feature's pages
    config/     feature-local configuration (NOT components):
                columns.tsx (useXColumns) · constants.ts (options / ranges / defaults) · schemas
```

### Feature folder convention

The unit of cohesion is the **feature**. Its root holds **exactly one file —
`index.ts`, the public API**; every other file is tucked into a sub-folder. So a
feature looks identical from the outside and the root never sprawls, no matter
how many pages it has:

- **index.ts** — the **only** file at the root. Re-exports the feature's page
  components (for the router) and any component other features may use. Outside
  code imports from `@/features/<x>` — **never** reaches into a sub-folder.
- **pages/** — every route screen, one file each (`jobs-list.tsx`,
  `job-detail.tsx`). Adding pages = adding files here; the root stays calm.
- **components/** — business components used by ≥1 of this feature's pages.
- **config/** — feature-local configuration, **not** components: `columns.tsx`
  (`useXColumns(handlers)`), `constants.ts` (options / ranges / defaults),
  schemas. A loose `config.ts` or `columns.tsx` must **not** sit at the root.

Use this shape **even for single-page features** (overview, metrics, health) —
the uniformity is worth it (`index.ts` always exists; a `config/` with a single
file is fine).

**Page-specific component clusters.** Default everything to flat `components/`.
Only when one page grows its own large cluster of private sub-components, give it
`pages/<screen>/` (the page + its private parts).

**Cross-feature reuse goes through `index.ts`, never a flat dump.** Example:
`DurableInstancePanel` is used by both the durable detail page **and** the job
detail page. It stays in `features/durable/components/` and is exposed via
`features/durable/index.ts`; the jobs feature imports
`{ DurableInstancePanel } from "@/features/durable"` — the **public API only**,
never reaching into another feature's internals.

```
features/durable/                 (the most complex: 2 pages + shared panel + external consumer)
  index.ts      export { DurableListPage, DurableDetailPage, DurableInstancePanel }
  pages/        durable-list.tsx · durable-detail.tsx
  components/   durable-instance-panel.tsx · durable-waterfall/ (split sub-parts)
  config/       columns.tsx · constants.ts
                                   ↑ DurableInstancePanel is consumed by features/jobs — via index.ts only
```

---

## Where config goes

"Config mixed into components" shows up at **two levels** — they go to different
homes:

| What                                                                                      | Examples (current)                                                                                              | Goes to                                                                                                                        |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Shared presentation tokens** — chip-color → tailwind class, _duplicated across files_   | `TINT` (×3) · `VALUE_TEXT` · `BADGE` — by semantic `ChipColor`                                                  | **`lib/tokens.ts`** as `chipTint` / `chipText` / `chipTextSoft` / `chipSolid` / `chipBadge` (consolidate; kill the copy-paste) |
| **Single-use status/level → class maps** — used by exactly one component                  | `DUR_DOT/DUR_TEXT` · `EVENT_COLOR/EVENT_DOT` · `PREFIX/STEP_BAR/ROOT_BAR` · queue-card `DOT/TEXT` · `OP_SYMBOL` | **co-locate** with the owning component / `config/constants.ts` (don't force single-use maps into `lib`)                       |
| **Feature-local config** — options / ranges / defaults                                    | `RANGES` (metrics) · `STATUS_OPTIONS` (durable) · `METRICS`/`OPERATORS` (alerts) · `DEFAULT_DATA` (schedulers)  | **`features/<x>/config/constants.ts`**                                                                                         |
| **Table column defs** — structure + cell renderers, currently inline `useMemo<ColumnDef>` | jobs-table · queues · durable · flows · schedulers                                                              | **`features/<x>/config/columns.tsx`** (export a `useXColumns(handlers)` hook)                                                  |

Rule: a **page** only does _compose + fetch + route_; tokens go up to `lib`,
feature config goes to `config/`, UI goes to `components/` — and the feature root
stays just `index.ts`.

---

## Where does X go? — quick guide

- A type used by both client and server → `src/shared/dto/<domain>.ts`.
- A type used only on the server → next to its module.
- A React component used by one feature → `features/<x>/components/`.
- A React component used by ≥2 features → `components/ui/` (generic) or expose the
  owning feature's via its `index.ts`.
- App chrome (shell / nav / palette) → `components/layout/`.
- A color/status→class map → `lib/tokens.ts`.
- A constant / option list for one feature → `features/<x>/config/constants.ts`.
- Table columns → `features/<x>/config/columns.tsx`.
- A React context provider → `lib/providers/`.
- A pure helper → `lib/*.ts`.
- Importing another feature → from `@/features/<x>` (its `index.ts`) **only** — never a sub-path.

> Feature-root invariant: `features/<x>/` contains **only `index.ts` + folders**.
> No other loose files at a feature root.

---

## Migration

Incremental, low-risk first; each step is independently shippable and verified
with `pnpm typecheck && pnpm build`.

- [x] 1. Split `src/shared/dto.ts` → `src/shared/dto/` + barrel (zero call-site churn). ✓
- [x] 2. Split `inspectors/bullmq-inspector.ts` → `inspectors/bullmq/*` (queue/job/scheduler/metrics/flow/redis + shared, composed in `index.ts`). ✓
- [x] 3. Consolidate duplicated presentation tokens → `lib/tokens.ts` (chipTint/chipBadge/chipSolid/chipText/chipTextSoft). ✓
- [x] 4. Reorg `components/` → `ui/` + `layout/` (+ `charts/`); moved single-feature components into their feature. ✓
- [x] 5. Per feature: root collapsed to **`index.ts` only** — pages → `pages/`, UI → `components/`, config → `config/` (`columns.tsx` hooks + `constants.ts`); public surface exported from `index.ts`, external imports routed through it (router + cross-feature). ✓
- [x] 6. Split the largest views: `durable-waterfall/` (model.ts · tooltips.tsx · index.tsx), `durable-instance-panel/` (index · summary · step-detail · event-log), overview-page (sub-components → `overview/components/`, page 446→238). ✓
- [x] 7. `lib/providers/` (config · confirm · time · toast · theme · actions) + `lib/api/` (index.ts + query.ts); `server/` root level-grouped into `middleware/` (auth) · `http/` (http-error · validate · contracts) · `infra/` (redis · util/). ✓

```

```
