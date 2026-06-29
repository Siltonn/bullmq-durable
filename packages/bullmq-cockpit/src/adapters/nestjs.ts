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
 * It depends only on `@nestjs/common` (an optional peer) and the default Express
 * platform; the cockpit core never imports Nest. Because the cockpit is mounted as
 * middleware (not via app.use mounting), the base path is passed explicitly so
 * the bridge can strip it from `req.url`.
 */

import { Inject, Module, RequestMethod } from "@nestjs/common"
import type { DynamicModule, MiddlewareConsumer, NestModule } from "@nestjs/common"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createCockpitApp, type CockpitApp } from "../server/app"
import { normalizeBasePath, type BullMQCockpitOptions } from "../server/options"
import { nodeToWebRequest, readNodeBody, sendWebResponse } from "./node-bridge"

export interface BullMQCockpitModuleOptions extends BullMQCockpitOptions {
  /** Mount path. Defaults to `/admin/bullmq`. */
  path?: string
}

interface ResolvedModule {
  cockpit: CockpitApp
  path: string
}

const COCKPIT_OPTIONS = Symbol("BULLMQ_COCKPIT_OPTIONS")

@Module({})
export class BullMQCockpitModule implements NestModule {
  constructor(@Inject(COCKPIT_OPTIONS) private readonly resolved: ResolvedModule) {}

  static register(options: BullMQCockpitModuleOptions): DynamicModule {
    const path = normalizeBasePath(options.path ?? "/admin/bullmq")
    const cockpit = createCockpitApp({ ...options, basePath: path })
    return {
      module: BullMQCockpitModule,
      providers: [{ provide: COCKPIT_OPTIONS, useValue: { cockpit, path } satisfies ResolvedModule }],
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
}
