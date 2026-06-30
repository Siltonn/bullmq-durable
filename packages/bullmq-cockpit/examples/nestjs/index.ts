/**
 * NestJS example: mounting the BullMQ Cockpit dashboard.
 *
 * `register` takes a literal connection; `registerAsync` sources it from DI
 * (shown here with a tiny config provider — swap in your own `ConfigService`).
 * The cockpit's Redis connections are built lazily and released on shutdown.
 *
 * NOTE: targets the default Express platform. On `@nestjs/platform-fastify`,
 * mount `bullmq-cockpit/fastify` directly instead of this module.
 */

import { Injectable, Module } from "@nestjs/common"
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
