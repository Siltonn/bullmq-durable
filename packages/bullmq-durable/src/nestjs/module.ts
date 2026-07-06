/**
 * {@link DurableBullModule} — the NestJS entry point.
 *
 * `forRoot` / `forRootAsync` register the shared connection/defaults plus the
 * {@link DurableExplorer}; `registerQueue` / `registerQueueAsync` expose one
 * injectable {@link DurableQueue} per queue (and record that queue's worker
 * overrides). Listing a queue's `processor` class auto-registers it so the
 * explorer discovers it — no need to remember the module's `providers`.
 *
 * This module deliberately does NOT depend on `@nestjs/bullmq`; it only mirrors
 * its developer experience.
 */

import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { DurableQueue } from "../queue"
import type { StateStore } from "../store/state-store"
import { DurableExplorer } from "./explorer"
import { createSharedStore, reuseSharedStore } from "./shared-store"
import {
  DURABLE_BULL_OPTIONS,
  DURABLE_QUEUE_NAMES,
  DURABLE_STATE_STORE,
  getDurableQueueOptionsToken,
  getDurableQueueToken,
} from "./tokens"
import type {
  DurableBullRootAsyncOptions,
  DurableBullRootOptions,
  DurableQueueAsyncRegistration,
  DurableQueueRegistration,
} from "./types"

/**
 * Accumulates the names of queues registered via `registerQueue(Async)`.
 * Provided (and exported) by the root module; each registration's eager
 * factory feeds it, and {@link DURABLE_QUEUE_NAMES} reads it lazily.
 */
export class DurableQueueNamesRegistry {
  private readonly names = new Set<string>()

  add(...names: string[]): void {
    for (const name of names) this.names.add(name)
  }

  all(): string[] {
    return [...this.names]
  }
}

@Module({})
export class DurableBullModule {
  /** Configure the shared connection and global defaults. */
  static forRoot(options: DurableBullRootOptions): DynamicModule {
    return this.rootModule(options.global, [{ provide: DURABLE_BULL_OPTIONS, useValue: options }])
  }

  /** Like {@link forRoot}, but resolves the root options from DI (e.g. `ConfigService`). */
  static forRootAsync(options: DurableBullRootAsyncOptions): DynamicModule {
    return this.rootModule(
      options.global,
      [
        {
          provide: DURABLE_BULL_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ],
      options.imports,
    )
  }

  /** Register one or more durable queues for injection. */
  static registerQueue(...queues: DurableQueueRegistration[]): DynamicModule {
    const providers: Provider[] = []
    const exported: unknown[] = []

    for (const registration of queues) {
      providers.push({
        provide: getDurableQueueOptionsToken(registration.name),
        useValue: registration,
      })
      this.collectQueueProviders(registration.name, registration.processor, providers, exported)
    }
    providers.push(this.namesRegistration(queues.map((q) => q.name)))

    return { module: DurableBullModule, providers, exports: exported as string[] }
  }

  /** Like {@link registerQueue}, but resolves each queue's options from DI. */
  static registerQueueAsync(...queues: DurableQueueAsyncRegistration[]): DynamicModule {
    const providers: Provider[] = []
    const exported: unknown[] = []
    const imports: NonNullable<DynamicModule["imports"]> = []

    for (const registration of queues) {
      if (registration.imports) imports.push(...registration.imports)

      const { name, useFactory, inject } = registration
      providers.push({
        provide: getDurableQueueOptionsToken(name),
        useFactory: async (...args: unknown[]): Promise<DurableQueueRegistration> => ({
          ...(await useFactory(...args)),
          name,
        }),
        inject: inject ?? [],
      })
      this.collectQueueProviders(name, registration.processor, providers, exported)
    }
    providers.push(this.namesRegistration(queues.map((q) => q.name)))

    return { module: DurableBullModule, imports, providers, exports: exported as string[] }
  }

  /** Eagerly feed this registration's queue names into the shared registry. */
  private static namesRegistration(names: string[]): Provider {
    return {
      // Unique token per call so multiple registrations never collide.
      provide: Symbol("DURABLE_QUEUE_NAMES_REGISTRATION"),
      useFactory: (registry: DurableQueueNamesRegistry): string[] => {
        registry.add(...names)
        return names
      },
      inject: [DurableQueueNamesRegistry],
    }
  }

  /** Shared root module shape for {@link forRoot} / {@link forRootAsync}. */
  private static rootModule(
    global: boolean | undefined,
    optionsProvider: Provider[],
    extraImports?: DynamicModule["imports"],
  ): DynamicModule {
    return {
      module: DurableBullModule,
      global: global ?? true,
      imports: [DiscoveryModule, ...(extraImports ?? [])],
      providers: [
        ...optionsProvider,
        {
          // One shared StateStore (hence one Redis connection) for every queue
          // and worker this module wires up.
          provide: DURABLE_STATE_STORE,
          useFactory: (root: DurableBullRootOptions) => createSharedStore(root),
          inject: [DURABLE_BULL_OPTIONS],
        },
        DurableExplorer,
        DurableQueueNamesRegistry,
        {
          provide: DURABLE_QUEUE_NAMES,
          useFactory: (registry: DurableQueueNamesRegistry) => () => registry.all(),
          inject: [DurableQueueNamesRegistry],
        },
      ],
      exports: [
        DURABLE_BULL_OPTIONS,
        DURABLE_STATE_STORE,
        DurableQueueNamesRegistry,
        DURABLE_QUEUE_NAMES,
      ],
    }
  }

  /**
   * Push the injectable {@link DurableQueue} provider (resolved from the per-queue
   * options token, so it works for both the sync and async forms) plus any
   * declared processor classes, recording what to export.
   */
  private static collectQueueProviders(
    name: string,
    processor: Type<unknown> | Type<unknown>[] | undefined,
    providers: Provider[],
    exported: unknown[],
  ): void {
    const queueToken = getDurableQueueToken(name)
    providers.push({
      provide: queueToken,
      useFactory: (
        root: DurableBullRootOptions,
        reg: DurableQueueRegistration,
        shared?: StateStore,
      ) =>
        new DurableQueue(name, {
          connection: root.connection,
          durablePrefix: reg.durablePrefix ?? root.durablePrefix,
          // `bullPrefix` is the deprecated 0.1.x alias for BullMQ's `prefix`.
          prefix: reg.prefix ?? reg.bullPrefix ?? root.prefix ?? root.bullPrefix,
          defaultJobOptions: reg.defaultJobOptions ?? root.defaultJobOptions,
          stateStore: reuseSharedStore(shared, root, reg.durablePrefix),
        }),
      inject: [
        DURABLE_BULL_OPTIONS,
        getDurableQueueOptionsToken(name),
        { token: DURABLE_STATE_STORE, optional: true },
      ],
    })
    exported.push(queueToken)

    for (const cls of toArray(processor)) {
      providers.push(cls)
      exported.push(cls)
    }
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}
