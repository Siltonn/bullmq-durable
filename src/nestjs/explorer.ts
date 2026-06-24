/**
 * {@link DurableExplorer} discovers `@DurableProcessor` providers at startup,
 * builds a job-name -> method handler map from their `@DurableProcess` methods,
 * and spins up a {@link DurableWorker} per processor.
 *
 * The worker construction is funnelled through an injectable factory so the
 * discovery logic can be unit-tested without opening a Redis connection.
 */

import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from "@nestjs/common"
import { DiscoveryService, ModuleRef, Reflector } from "@nestjs/core"
import { DurableWorker } from "../worker"
import type { DurableProcessor, DurableWorkerOptions } from "../types"
import {
  DURABLE_BULL_OPTIONS,
  DURABLE_PROCESS_METADATA,
  DURABLE_PROCESSOR_METADATA,
  DURABLE_WORKER_FACTORY,
  getDurableQueueOptionsToken,
} from "./tokens"
import type {
  DurableBullRootOptions,
  DurableProcessMetadata,
  DurableProcessorMetadata,
  DurableQueueRegistration,
  DurableWorkerFactory,
  DurableWorkerHandle,
} from "./types"

/** Default factory: build a real {@link DurableWorker}. */
const defaultWorkerFactory: DurableWorkerFactory = (queueName, processor, options) =>
  new DurableWorker(queueName, processor, options)

@Injectable()
export class DurableExplorer implements OnModuleInit, OnModuleDestroy {
  private readonly workers: DurableWorkerHandle[] = []

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    // Explicit override used by unit tests that construct the explorer directly.
    @Optional()
    @Inject(DURABLE_WORKER_FACTORY)
    private readonly explicitFactory?: DurableWorkerFactory,
  ) {}

  onModuleInit(): void {
    const factory = this.resolveFactory()

    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance
      if (!instance || typeof instance !== "object") continue

      const meta = this.reflector.get<DurableProcessorMetadata>(
        DURABLE_PROCESSOR_METADATA,
        instance.constructor,
      )
      if (!meta) continue

      const handlers = this.buildHandlerMap(instance)
      if (Object.keys(handlers).length === 0) continue

      const options = this.resolveWorkerOptions(meta.queueName)
      this.workers.push(factory(meta.queueName, handlers, options))
    }
  }

  /**
   * Resolve the worker factory: an explicitly-injected one wins, otherwise look
   * it up across the whole app (so it can be overridden in tests), falling back
   * to building a real {@link DurableWorker}.
   */
  private resolveFactory(): DurableWorkerFactory {
    return (
      this.explicitFactory ??
      this.get<DurableWorkerFactory>(DURABLE_WORKER_FACTORY) ??
      defaultWorkerFactory
    )
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close().catch(() => undefined)))
    this.workers.length = 0
  }

  /** Number of workers started — handy for assertions in tests. */
  get workerCount(): number {
    return this.workers.length
  }

  /** Build a `{ jobName: boundMethod }` map from `@DurableProcess` methods. */
  private buildHandlerMap(instance: object): Record<string, DurableProcessor> {
    const handlers: Record<string, DurableProcessor> = {}
    const seen = new Set<string>()

    // Walk the whole prototype chain so `@DurableProcess` methods inherited from
    // a base class are discovered too. A more-derived method shadows a base one
    // of the same name (we visit derived prototypes first).
    let prototype = Object.getPrototypeOf(instance) as Record<string, unknown> | null
    while (prototype && prototype !== Object.prototype) {
      for (const propertyName of Object.getOwnPropertyNames(prototype)) {
        if (propertyName === "constructor" || seen.has(propertyName)) continue
        seen.add(propertyName)

        const method = prototype[propertyName]
        if (typeof method !== "function") continue

        const processMeta = this.reflector.get<DurableProcessMetadata>(
          DURABLE_PROCESS_METADATA,
          method,
        )
        if (!processMeta) continue

        handlers[processMeta.jobName] = (method as DurableProcessor).bind(
          instance,
        ) as DurableProcessor
      }
      prototype = Object.getPrototypeOf(prototype) as Record<string, unknown> | null
    }

    return handlers
  }

  /** Merge per-queue registration options over the root defaults. */
  private resolveWorkerOptions(queueName: string): DurableWorkerOptions {
    const root = this.get<DurableBullRootOptions>(DURABLE_BULL_OPTIONS)
    if (!root) {
      throw new Error(
        "DurableExplorer could not resolve DURABLE_BULL_OPTIONS. Did you import DurableBullModule.forRoot()?",
      )
    }
    const queue = this.get<DurableQueueRegistration>(getDurableQueueOptionsToken(queueName))

    return {
      connection: root.connection,
      durablePrefix: queue?.durablePrefix ?? root.durablePrefix,
      bullPrefix: queue?.bullPrefix ?? root.bullPrefix,
      concurrency: queue?.concurrency ?? root.concurrency,
      lockTimeout: queue?.lockTimeout ?? root.lockTimeout,
      retention: queue?.retention ?? root.retention,
      defaultStepOptions: queue?.defaultStepOptions ?? root.defaultStepOptions,
      maxLogs: queue?.maxLogs ?? root.maxLogs,
    }
  }

  /** Resolve an optional provider by token without throwing when absent. */
  private get<T>(token: unknown): T | undefined {
    try {
      return this.moduleRef.get<T>(token as never, { strict: false })
    } catch {
      return undefined
    }
  }
}
