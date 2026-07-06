/**
 * NestJS example: mounting the BullMQ Cockpit dashboard.
 *
 * `forRoot` takes a literal connection; `forRootAsync` sources it from DI
 * (shown here with a tiny config provider — swap in your own `ConfigService`).
 * `register` / `registerAsync` remain as aliases. The cockpit's Redis
 * connections are built lazily and released on shutdown.
 *
 * The same module works on **both** platforms — the default Express one and
 * `@nestjs/platform-fastify` — with no extra configuration (see `bootstrap`
 * below). Nest's Fastify platform bundles middie, so the middleware just works.
 */

import { Injectable, Module } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { DURABLE_QUEUE_NAMES, DurableBullModule } from "bullmq-durable/nestjs"
import { BullMQCockpitModule } from "bullmq-cockpit/nestjs"

const connection = { host: "127.0.0.1", port: 6379 }

// --- Simple: a literal connection -------------------------------------------

@Module({
  imports: [
    BullMQCockpitModule.forRoot({
      path: "/admin/bullmq",
      connection,
      // Queues are explicit under NestJS (no Redis auto-discovery). List them here…
      queues: ["emails"],
      // Always set `auth` in production — the dashboard is open otherwise.
      // Guards/interceptors don't run for middleware routes, so authorize here.
      auth: ({ header }) => header("x-admin-token") === process.env.ADMIN_TOKEN,
    }),
    // …and/or contribute more from feature modules; the lists are merged.
    BullMQCockpitModule.registerQueue("media", "billing"),
  ],
})
export class SimpleAdminModule {}

// --- DI-sourced: forRootAsync -------------------------------------------------

@Injectable()
export class RedisConfig {
  readonly connection = connection
  // Any queue-name source works as a `queues` thunk (read lazily per request).
  readonly queueNames = ["emails", "media"]
}

@Module({
  providers: [RedisConfig],
  exports: [RedisConfig],
})
export class ConfigModule {}

@Module({
  imports: [
    BullMQCockpitModule.forRootAsync({
      path: "/admin/bullmq",
      imports: [ConfigModule],
      inject: [RedisConfig],
      useFactory: (config: RedisConfig) => ({
        connection: config.connection,
        queues: () => config.queueNames,
      }),
    }),
  ],
})
export class AsyncAdminModule {}

// --- With bullmq-durable: zero double-registration ----------------------------
// `DurableBullModule.registerQueue` already declares your queues once; inject
// durable's DURABLE_QUEUE_NAMES thunk so the dashboard sees exactly those —
// no matching BullMQCockpitModule.registerQueue calls to keep in sync. Names
// from `registerQueue` / root `queues` are still merged in if you add any.

@Module({
  imports: [
    DurableBullModule.forRoot({ connection }), // global by default
    // …DurableBullModule.registerQueue({ name: "generation", processor })
    //   in your feature modules, exactly as usual…
    BullMQCockpitModule.forRootAsync({
      path: "/admin/bullmq",
      inject: [DURABLE_QUEUE_NAMES],
      useFactory: (durableQueues: () => string[]) => ({
        connection,
        queues: durableQueues,
      }),
    }),
  ],
})
export class DurableAdminModule {}

// --- Bootstrapping on either platform ---------------------------------------
// The module is identical across platforms; only the app factory differs.

/** Default Express platform. */
export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(SimpleAdminModule)
  await app.listen(3000)
  // Dashboard → http://localhost:3000/admin/bullmq
}

// For Fastify, the module above is unchanged — only swap the adapter:
//
//   import { FastifyAdapter } from "@nestjs/platform-fastify"
//   const app = await NestFactory.create(SimpleAdminModule, new FastifyAdapter())
//   await app.listen(3000)
//
// Nest's Fastify platform bundles the middie engine, so the dashboard middleware
// runs with no extra configuration.
