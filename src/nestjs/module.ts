/**
 * {@link DurableBullModule} — the NestJS entry point.
 *
 * `forRoot` registers the shared connection/defaults plus the
 * {@link DurableExplorer}; `registerQueue` exposes one injectable
 * {@link DurableQueue} per queue (and records that queue's worker overrides).
 *
 * This module deliberately does NOT depend on `@nestjs/bullmq`; it only mirrors
 * its developer experience.
 */

import { type DynamicModule, Module, type Provider } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { DurableQueue } from "../queue"
import type { StateStore } from "../store/state-store"
import { DurableExplorer } from "./explorer"
import { createSharedStore, reuseSharedStore } from "./shared-store"
import {
  DURABLE_BULL_OPTIONS,
  DURABLE_STATE_STORE,
  getDurableQueueOptionsToken,
  getDurableQueueToken,
} from "./tokens"
import type { DurableBullRootOptions, DurableQueueRegistration } from "./types"

@Module({})
export class DurableBullModule {
  /** Configure the shared connection and global defaults. */
  static forRoot(options: DurableBullRootOptions): DynamicModule {
    return {
      module: DurableBullModule,
      global: options.global ?? true,
      imports: [DiscoveryModule],
      providers: [
        { provide: DURABLE_BULL_OPTIONS, useValue: options },
        {
          // One shared StateStore (hence one Redis connection) for every queue
          // and worker this module wires up.
          provide: DURABLE_STATE_STORE,
          useFactory: (root: DurableBullRootOptions) => createSharedStore(root),
          inject: [DURABLE_BULL_OPTIONS],
        },
        DurableExplorer,
      ],
      exports: [DURABLE_BULL_OPTIONS, DURABLE_STATE_STORE],
    }
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

      const queueToken = getDurableQueueToken(registration.name)
      providers.push({
        provide: queueToken,
        useFactory: (root: DurableBullRootOptions, shared?: StateStore) =>
          new DurableQueue(registration.name, {
            connection: root.connection,
            durablePrefix: registration.durablePrefix ?? root.durablePrefix,
            bullPrefix: registration.bullPrefix ?? root.bullPrefix,
            defaultJobOptions: registration.defaultJobOptions,
            stateStore: reuseSharedStore(shared, root, registration.durablePrefix),
          }),
        inject: [DURABLE_BULL_OPTIONS, { token: DURABLE_STATE_STORE, optional: true }],
      })
      exported.push(queueToken)
    }

    return {
      module: DurableBullModule,
      providers,
      exports: exported as string[],
    }
  }
}
