import "reflect-metadata"
import { Injectable } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectionOptions } from "bullmq"
import {
  DURABLE_BULL_OPTIONS,
  DURABLE_PROCESS_METADATA,
  DURABLE_PROCESSOR_METADATA,
  DURABLE_WORKER_FACTORY,
  DurableBullModule,
  DurableExplorer,
  DurableFailure,
  DurableProcess,
  DurableProcessor,
  DurableQueue,
  getDurableQueueOptionsToken,
  getDurableQueueToken,
  InjectDurableQueue,
} from "../src/nestjs/index"
import type { DurableWorkerFactory } from "../src/nestjs/types"
import { MemoryStateStore } from "../src/index"

const CONNECTION = { host: "127.0.0.1", port: 6379 } as ConnectionOptions

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

@DurableProcessor("generation")
class GenerationProcessor {
  readonly calls: string[] = []

  @DurableProcess("video")
  async video(): Promise<string> {
    this.calls.push("video")
    return "video"
  }

  @DurableProcess("image")
  async image(): Promise<string> {
    this.calls.push("image")
    return "image"
  }

  // The processor's single terminal-failure handler — settles every job.
  @DurableFailure()
  async onFailure(): Promise<void> {
    this.calls.push("failure")
  }

  // A method without the decorator must be ignored by discovery.
  async helper(): Promise<void> {}
}

@Injectable()
class GenerationService {
  constructor(@InjectDurableQueue("generation") readonly queue: DurableQueue) {}
}

// A processor that inherits a @DurableProcess method from a base class.
@DurableProcessor("media")
class BaseMediaProcessor {
  @DurableProcess("transcode")
  async transcode(): Promise<string> {
    return "transcode"
  }
}

class MediaProcessor extends BaseMediaProcessor {
  @DurableProcess("thumbnail")
  async thumbnail(): Promise<string> {
    return "thumbnail"
  }
}

// A processor that declares two @DurableFailure() handlers (ambiguous).
@DurableProcessor("ambiguous")
class AmbiguousFailureProcessor {
  @DurableProcess("a")
  async a(): Promise<string> {
    return "a"
  }

  @DurableFailure()
  async first(): Promise<void> {}

  @DurableFailure()
  async second(): Promise<void> {}
}

// ---------------------------------------------------------------------------

describe("nestjs decorators & tokens", () => {
  it("builds stable provider tokens", () => {
    expect(getDurableQueueToken("generation")).toBe("BULLMQ_DURABLE_QUEUE:generation")
    expect(getDurableQueueOptionsToken("generation")).toBe("BULLMQ_DURABLE_QUEUE_OPTS:generation")
  })

  it("attaches processor and process metadata", () => {
    const reflector = new Reflector()
    const instance = new GenerationProcessor()

    expect(reflector.get(DURABLE_PROCESSOR_METADATA, GenerationProcessor)).toEqual({
      queueName: "generation",
    })

    const prototype = Object.getPrototypeOf(instance)
    expect(reflector.get(DURABLE_PROCESS_METADATA, prototype.video)).toEqual({ jobName: "video" })
    expect(reflector.get(DURABLE_PROCESS_METADATA, prototype.helper)).toBeUndefined()
  })
})

describe("DurableExplorer", () => {
  it("discovers processors, builds a handler map, and starts one worker", async () => {
    const instance = new GenerationProcessor()
    const created: Array<{ queueName: string; processor: Record<string, unknown>; options: any }> =
      []

    const factory: DurableWorkerFactory = (queueName, processor, options) => {
      created.push({ queueName, processor: processor as Record<string, unknown>, options })
      return { close: async () => undefined }
    }

    const discovery = {
      getProviders: () => [{ instance }, { instance: null }, { instance: {} }],
    }
    const moduleRef = {
      get: (token: unknown) => {
        if (token === DURABLE_BULL_OPTIONS) {
          return { connection: CONNECTION, retention: { completed: "7d" } }
        }
        if (token === getDurableQueueOptionsToken("generation")) {
          return { name: "generation", concurrency: 5 }
        }
        throw new Error("unknown token")
      },
    }

    const explorer = new DurableExplorer(
      discovery as never,
      new Reflector(),
      moduleRef as never,
      factory,
    )
    explorer.onModuleInit()

    expect(explorer.workerCount).toBe(1)
    expect(created).toHaveLength(1)
    expect(created[0]?.queueName).toBe("generation")
    expect(Object.keys(created[0]!.processor).sort()).toEqual(["image", "video"])

    // Queue override wins; root default fills the rest.
    expect(created[0]?.options.concurrency).toBe(5)
    expect(created[0]?.options.retention).toEqual({ completed: "7d" })
    expect(created[0]?.options.connection).toBe(CONNECTION)

    // Handlers are bound to the instance, wrapped as `{ run }`.
    const videoHandler = created[0]!.processor.video as { run: () => Promise<string> }
    await videoHandler.run()
    expect(instance.calls).toContain("video")

    // @DurableFailure() is the worker-wide settlement, not attached per job...
    expect((created[0]!.processor.video as { onFailure?: unknown }).onFailure).toBeUndefined()
    expect((created[0]!.processor.image as { onFailure?: unknown }).onFailure).toBeUndefined()

    // ...it is handed to the worker as options.onFailure, bound to the instance.
    expect(typeof created[0]!.options.onFailure).toBe("function")
    await created[0]!.options.onFailure()
    expect(instance.calls).toContain("failure")

    await explorer.onModuleDestroy()
  })

  it("throws when a processor declares more than one @DurableFailure()", () => {
    const instance = new AmbiguousFailureProcessor()
    const factory: DurableWorkerFactory = () => ({ close: async () => undefined })
    const discovery = { getProviders: () => [{ instance }] }
    const moduleRef = {
      get: (token: unknown) =>
        token === DURABLE_BULL_OPTIONS ? { connection: CONNECTION } : undefined,
    }
    const explorer = new DurableExplorer(
      discovery as never,
      new Reflector(),
      moduleRef as never,
      factory,
    )
    expect(() => explorer.onModuleInit()).toThrow(/at most one/)
  })

  it("discovers @DurableProcess methods inherited from a base class", () => {
    const instance = new MediaProcessor()
    const created: Array<Record<string, unknown>> = []
    const factory: DurableWorkerFactory = (_queueName, processor) => {
      created.push(processor as Record<string, unknown>)
      return { close: async () => undefined }
    }
    const discovery = { getProviders: () => [{ instance }] }
    const moduleRef = {
      get: (token: unknown) =>
        token === DURABLE_BULL_OPTIONS ? { connection: CONNECTION } : undefined,
    }

    const explorer = new DurableExplorer(
      discovery as never,
      new Reflector(),
      moduleRef as never,
      factory,
    )
    explorer.onModuleInit()

    expect(created).toHaveLength(1)
    // Both the inherited `transcode` and the subclass's own `thumbnail`.
    expect(Object.keys(created[0]!).sort()).toEqual(["thumbnail", "transcode"])
  })

  it("ignores providers without @DurableProcessor", async () => {
    const factory = vi.fn<DurableWorkerFactory>(() => ({ close: async () => undefined }))
    const discovery = { getProviders: () => [{ instance: new GenerationService(null as never) }] }
    const moduleRef = { get: () => ({ connection: CONNECTION }) }

    const explorer = new DurableExplorer(
      discovery as never,
      new Reflector(),
      moduleRef as never,
      factory,
    )
    explorer.onModuleInit()
    expect(factory).not.toHaveBeenCalled()
  })
})

describe("DurableBullModule", () => {
  it("forRoot is global by default and exposes the options token", () => {
    const dynamic = DurableBullModule.forRoot({ connection: CONNECTION })
    expect(dynamic.module).toBe(DurableBullModule)
    expect(dynamic.global).toBe(true)
    expect(dynamic.exports).toContain(DURABLE_BULL_OPTIONS)

    expect(DurableBullModule.forRoot({ connection: CONNECTION, global: false }).global).toBe(false)
  })

  it("registerQueue exports a token per queue", () => {
    const dynamic = DurableBullModule.registerQueue({ name: "a" }, { name: "b" })
    expect(dynamic.exports).toContain(getDurableQueueToken("a"))
    expect(dynamic.exports).toContain(getDurableQueueToken("b"))
  })

  it("wires injectable queues and discovers processors end to end", async () => {
    const store = new MemoryStateStore()
    const started: string[] = []
    const factory: DurableWorkerFactory = (queueName) => {
      started.push(queueName)
      return { close: async () => undefined }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableBullModule.forRoot({ connection: CONNECTION, global: true, stateStore: store }),
        DurableBullModule.registerQueue({ name: "generation", concurrency: 3 }),
      ],
      providers: [
        { provide: DURABLE_WORKER_FACTORY, useValue: factory },
        GenerationProcessor,
        GenerationService,
      ],
    }).compile()

    // Trigger onModuleInit so the explorer runs.
    await moduleRef.init()

    const queue = moduleRef.get<DurableQueue>(getDurableQueueToken("generation"), { strict: false })
    expect(queue).toBeInstanceOf(DurableQueue)
    expect(queue.stateStore).toBe(store)

    const service = moduleRef.get(GenerationService)
    expect(service.queue).toBeInstanceOf(DurableQueue)

    expect(started).toContain("generation")

    await moduleRef.close()
  })

  it("shares one StateStore (and connection) across every queue and worker", async () => {
    const store = new MemoryStateStore()
    const workerOptions: Array<{ stateStore?: unknown }> = []
    const factory: DurableWorkerFactory = (_queueName, _processor, options) => {
      workerOptions.push(options)
      return { close: async () => undefined }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableBullModule.forRoot({ connection: CONNECTION, stateStore: store }),
        DurableBullModule.registerQueue({ name: "generation" }, { name: "media" }),
      ],
      providers: [
        { provide: DURABLE_WORKER_FACTORY, useValue: factory },
        GenerationProcessor,
        MediaProcessor,
      ],
    }).compile()
    await moduleRef.init()

    // Two processors -> two workers, each handed the same store instance.
    expect(workerOptions).toHaveLength(2)
    for (const options of workerOptions) {
      expect(options.stateStore).toBe(store)
    }

    // The injectable queues reuse it as well.
    const gen = moduleRef.get<DurableQueue>(getDurableQueueToken("generation"), { strict: false })
    const media = moduleRef.get<DurableQueue>(getDurableQueueToken("media"), { strict: false })
    expect(gen.stateStore).toBe(store)
    expect(media.stateStore).toBe(store)

    await moduleRef.close()
  })

  it("forRootAsync resolves the root options from a factory", async () => {
    const store = new MemoryStateStore()
    const started: string[] = []
    const factory: DurableWorkerFactory = (queueName) => {
      started.push(queueName)
      return { close: async () => undefined }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableBullModule.forRootAsync({
          useFactory: () => ({ connection: CONNECTION, stateStore: store }),
        }),
        DurableBullModule.registerQueue({ name: "generation" }),
      ],
      providers: [{ provide: DURABLE_WORKER_FACTORY, useValue: factory }, GenerationProcessor],
    }).compile()
    await moduleRef.init()

    const opts = moduleRef.get<{ stateStore?: unknown }>(DURABLE_BULL_OPTIONS, { strict: false })
    expect(opts.stateStore).toBe(store)
    expect(started).toContain("generation")

    const queue = moduleRef.get<DurableQueue>(getDurableQueueToken("generation"), { strict: false })
    expect(queue.stateStore).toBe(store)

    await moduleRef.close()
  })

  it("registerQueueAsync resolves per-queue options from a factory", async () => {
    const store = new MemoryStateStore()
    const workerOptions: Array<{ concurrency?: number }> = []
    const factory: DurableWorkerFactory = (_queueName, _processor, options) => {
      workerOptions.push(options)
      return { close: async () => undefined }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableBullModule.forRoot({ connection: CONNECTION, stateStore: store }),
        DurableBullModule.registerQueueAsync({
          name: "generation",
          useFactory: () => ({ concurrency: 7 }),
        }),
      ],
      providers: [{ provide: DURABLE_WORKER_FACTORY, useValue: factory }, GenerationProcessor],
    }).compile()
    await moduleRef.init()

    expect(workerOptions[0]?.concurrency).toBe(7)
    const queue = moduleRef.get<DurableQueue>(getDurableQueueToken("generation"), { strict: false })
    expect(queue).toBeInstanceOf(DurableQueue)

    await moduleRef.close()
  })

  it("registerQueue({ processor }) auto-registers the processor without a providers entry", async () => {
    const store = new MemoryStateStore()
    const started: string[] = []
    const factory: DurableWorkerFactory = (queueName) => {
      started.push(queueName)
      return { close: async () => undefined }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableBullModule.forRoot({ connection: CONNECTION, stateStore: store }),
        // GenerationProcessor is declared only via `processor`, not in `providers`.
        DurableBullModule.registerQueue({ name: "generation", processor: GenerationProcessor }),
      ],
      providers: [{ provide: DURABLE_WORKER_FACTORY, useValue: factory }],
    }).compile()
    await moduleRef.init()

    expect(started).toContain("generation")

    await moduleRef.close()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
