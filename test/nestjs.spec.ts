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
  DurableProcess,
  DurableProcessor,
  DurableQueue,
  getDurableQueueOptionsToken,
  getDurableQueueToken,
  InjectDurableQueue,
} from "../src/nestjs/index"
import type { DurableWorkerFactory } from "../src/nestjs/types"

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

    // Handlers are bound to the instance.
    await (created[0]!.processor.video as () => Promise<string>)()
    expect(instance.calls).toContain("video")

    await explorer.onModuleDestroy()
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
    const started: string[] = []
    const factory: DurableWorkerFactory = (queueName) => {
      started.push(queueName)
      return { close: async () => undefined }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableBullModule.forRoot({ connection: CONNECTION, global: true }),
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

    const queue = moduleRef.get(getDurableQueueToken("generation"), { strict: false })
    expect(queue).toBeInstanceOf(DurableQueue)

    const service = moduleRef.get(GenerationService)
    expect(service.queue).toBeInstanceOf(DurableQueue)

    expect(started).toContain("generation")

    await moduleRef.close()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
