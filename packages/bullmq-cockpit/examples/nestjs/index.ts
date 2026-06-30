/**
 * NestJS example: mounting the BullMQ Cockpit dashboard.
 *
 * `register` takes a literal connection; `registerAsync` sources it from DI
 * (shown here with a tiny config provider — swap in your own `ConfigService`).
 * The cockpit's Redis connections are built lazily and released on shutdown.
 *
 * The same module works on **both** platforms — the default Express one and
 * `@nestjs/platform-fastify` — with no extra configuration (see `bootstrap`
 * below). Nest's Fastify platform bundles middie, so the middleware just works.
 */

import { Injectable, Module } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { BullMQCockpitModule } from "bullmq-cockpit/nestjs"

const connection = { host: "127.0.0.1", port: 6379 }

// --- Simple: a literal connection -------------------------------------------

@Module({
  imports: [
    BullMQCockpitModule.register({
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

// --- DI-sourced: registerAsync ----------------------------------------------

@Injectable()
export class RedisConfig {
  readonly connection = connection
}

@Module({
  providers: [RedisConfig],
  exports: [RedisConfig],
})
export class ConfigModule {}

@Module({
  imports: [
    BullMQCockpitModule.registerAsync({
      path: "/admin/bullmq",
      imports: [ConfigModule],
      inject: [RedisConfig],
      useFactory: (config: RedisConfig) => ({ connection: config.connection }),
    }),
  ],
})
export class AsyncAdminModule {}

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
