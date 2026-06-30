/**
 * NestJS adapter — a dynamic module that mounts the cockpit as middleware.
 *
 *   import { BullMQCockpitModule } from "bullmq-cockpit/nestjs"
 *
 *   @Module({
 *     imports: [BullMQCockpitModule.register({ path: "/admin/bullmq", connection })],
 *   })
 *   export class AdminModule {}
 *
 *   // …or source connection / auth from DI:
 *   @Module({
 *     imports: [
 *       BullMQCockpitModule.registerAsync({
 *         path: "/admin/bullmq",
 *         imports: [ConfigModule],
 *         inject: [ConfigService],
 *         useFactory: (config: ConfigService) => ({ connection: config.get("redis") }),
 *       }),
 *     ],
 *   })
 *   export class AdminModule {}
 *
 * It depends only on `@nestjs/common` (an optional peer) and the default Express
 * platform; the cockpit core never imports Nest. Because the cockpit is mounted as
 * middleware (not via app.use mounting), the base path is passed explicitly (as
 * `path`) so the bridge can strip it from `req.url`.
 *
 * The cockpit app (and its Redis connections) is built lazily inside a DI factory
 * — not at module-definition time — and released on application shutdown.
 *
 * Queues are **explicit** under NestJS: pass `queues` to `register`, and/or call
 * `BullMQCockpitModule.registerQueue(...)` from feature modules. The dashboard
 * never auto-discovers by scanning Redis — it shows exactly what you register.
 *
 * Caveats:
 *  - **Platform**: the wildcard route (`${path}/(.*)`) and raw `IncomingMessage`/
 *    `ServerResponse` plumbing assume the **default Express platform**. On
 *    `@nestjs/platform-fastify`, register the Fastify adapter
 *    (`bullmq-cockpit/fastify`) directly instead of this module.
 *  - **Auth**: this is mounted as middleware, so Nest guards/interceptors do NOT
 *    run for cockpit routes — do authorization inside the `auth` hook. Its `req`
 *    is the raw (Express) request, so only data attached by middleware that ran
 *    earlier (e.g. session/passport) is visible as `req.user`.
 */

import { Inject, Injectable, Module, RequestMethod } from "@nestjs/common"
import type {
  DynamicModule,
  MiddlewareConsumer,
  ModuleMetadata,
  NestModule,
  OnApplicationShutdown,
  Provider,
  Type,
} from "@nestjs/common"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createCockpitApp, type CockpitApp } from "../server/app"
import { normalizeBasePath, type BullMQCockpitOptions } from "../server/options"
import { nodeToWebRequest, readNodeBody, sendWebResponse } from "./node-bridge"

export interface BullMQCockpitModuleOptions extends Omit<BullMQCockpitOptions, "basePath"> {
  /**
   * Mount path. Defaults to `/admin/bullmq`. This is the canonical name here —
   * the shared `basePath` option is derived from it, so it is omitted above to
   * avoid two names for one concept.
   */
  path?: string
}

/** A factory dependency token — mirrors NestJS' own `inject` array entries. */
export type CockpitInjectionToken =
  | string
  | symbol
  | Type<unknown>
  | (new (...args: any[]) => unknown)

/** Async form of {@link BullMQCockpitModuleOptions}: source the options from DI. */
export interface BullMQCockpitModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  /** Mount path. Defaults to `/admin/bullmq`. */
  path?: string
  /** Providers injected into `useFactory`. */
  inject?: CockpitInjectionToken[]
  /** Builds the cockpit options, possibly asynchronously. */
  useFactory: (...args: any[]) => BullMQCockpitOptions | Promise<BullMQCockpitOptions>
}

interface ResolvedModule {
  cockpit: CockpitApp
  path: string
}

/**
 * The cockpit's queue allow-list, accumulated across the root `register` call and
 * every `registerQueue` in feature modules. The cockpit reads it lazily (per
 * request), so additions made by any module before the first request are seen —
 * regardless of provider instantiation order. Its mere presence disables Redis
 * auto-discovery: the NestJS dashboard only shows queues you register explicitly.
 */
@Injectable()
export class CockpitQueueRegistry {
  private readonly names = new Set<string>()

  /** Register one or more queue names. */
  add(...names: string[]): void {
    for (const name of names) this.names.add(name)
  }

  /** The current allow-list. */
  all(): string[] {
    return [...this.names]
  }
}

const COCKPIT_RAW_OPTIONS = Symbol("BULLMQ_COCKPIT_RAW_OPTIONS")
const COCKPIT_RESOLVED = Symbol("BULLMQ_COCKPIT_RESOLVED")

@Module({})
export class BullMQCockpitModule implements NestModule, OnApplicationShutdown {
  constructor(@Inject(COCKPIT_RESOLVED) private readonly resolved: ResolvedModule) {}

  static register(options: BullMQCockpitModuleOptions): DynamicModule {
    return this.build([{ provide: COCKPIT_RAW_OPTIONS, useValue: options }])
  }

  static registerAsync(options: BullMQCockpitModuleAsyncOptions): DynamicModule {
    return this.build(
      [
        {
          provide: COCKPIT_RAW_OPTIONS,
          useFactory: async (...args: unknown[]): Promise<BullMQCockpitModuleOptions> => ({
            ...(await options.useFactory(...args)),
            path: options.path,
          }),
          inject: options.inject ?? [],
        },
      ],
      options.imports,
    )
  }

  /**
   * Register queue names to expose, from any feature module — mirroring
   * `DurableBullModule.registerQueue`. Names accumulate into the shared
   * {@link CockpitQueueRegistry}; the dashboard never auto-discovers, so only the
   * queues you register here (or pass to `register({ queues })`) are shown.
   *
   *   @Module({ imports: [BullMQCockpitModule.registerQueue("emails", "media")] })
   *   export class EmailsModule {}
   */
  static registerQueue(...names: string[]): DynamicModule {
    return {
      module: BullMQCockpitModule,
      providers: [
        {
          // A unique token per call so multiple registrations don't collide;
          // the factory runs eagerly at bootstrap and feeds the shared registry.
          provide: Symbol("BULLMQ_COCKPIT_QUEUE_REGISTRATION"),
          useFactory: (registry: CockpitQueueRegistry): string[] => {
            registry.add(...names)
            return names
          },
          inject: [CockpitQueueRegistry],
        },
      ],
    }
  }

  /** Shared module shape: resolve options → lazily build the cockpit app. */
  private static build(
    optionsProvider: Provider[],
    imports?: DynamicModule["imports"],
  ): DynamicModule {
    return {
      module: BullMQCockpitModule,
      // Global so `registerQueue` in any feature module can reach the shared registry.
      global: true,
      imports: imports ?? [],
      providers: [
        ...optionsProvider,
        CockpitQueueRegistry,
        {
          provide: COCKPIT_RESOLVED,
          useFactory: (
            raw: BullMQCockpitModuleOptions,
            registry: CockpitQueueRegistry,
          ): ResolvedModule => {
            // Seed the registry with any queues passed at the root, then hand the
            // cockpit a live view of it — read per request, so queues registered
            // by feature modules are picked up and Redis is never scanned.
            if (Array.isArray(raw.queues)) registry.add(...raw.queues)
            const path = normalizeBasePath(raw.path ?? "/admin/bullmq")
            const cockpit = createCockpitApp({
              ...raw,
              basePath: path,
              queues: () => registry.all(),
            })
            return { cockpit, path }
          },
          inject: [COCKPIT_RAW_OPTIONS, CockpitQueueRegistry],
        },
      ],
      exports: [CockpitQueueRegistry],
    }
  }

  configure(consumer: MiddlewareConsumer): void {
    const { cockpit, path } = this.resolved

    const middleware = async (
      req: IncomingMessage,
      res: ServerResponse,
      next: (err?: unknown) => void,
    ): Promise<void> => {
      try {
        const fullPath = req.url ?? "/"
        const stripped =
          path && fullPath.startsWith(path) ? fullPath.slice(path.length) || "/" : fullPath
        const body = await readNodeBody(req)
        const webReq = nodeToWebRequest(req, stripped, body)
        const response = await cockpit.app.fetch(webReq)
        await sendWebResponse(res, response)
      } catch (err) {
        next(err)
      }
    }

    consumer
      .apply(middleware)
      .forRoutes(
        { path: path || "/", method: RequestMethod.ALL },
        { path: `${path}/(.*)`, method: RequestMethod.ALL },
      )
  }

  /** Release the cockpit's Redis connections when the app shuts down. */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.resolved.cockpit.context.close()
    } catch {
      // Best-effort: the process is shutting down regardless.
    }
  }
}
