import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildQueueOptions } from "../src/queue"
import { buildWorkerOptions } from "../src/worker"
import { resetDeprecationWarnings } from "../src/utils/deprecations"

describe("0.1.x option soft-landing", () => {
  beforeEach(() => {
    resetDeprecationWarnings()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("maps bullPrefix to prefix and strips durable-only fields (worker)", () => {
    const built = buildWorkerOptions({
      connection: { host: "localhost" },
      bullPrefix: "legacy-bull",
      durablePrefix: "durable",
      lockTimeout: "5m",
      retention: { completed: "24h" },
      maxLogs: 500,
      resumeAttempts: 3,
      concurrency: 7,
      defaultStepOptions: { retry: { attempts: 2 } },
      onFailure: async () => undefined,
    })

    expect(built.prefix).toBe("legacy-bull")
    expect(built.concurrency).toBe(7)
    // Durable-only + removed fields never reach BullMQ's Worker constructor.
    for (const key of [
      "durablePrefix",
      "stateStore",
      "defaultStepOptions",
      "defaultRollbackRetry",
      "onFailure",
      "bullPrefix",
      "lockTimeout",
      "retention",
      "maxLogs",
      "resumeAttempts",
      "bullWorkerOptions",
    ]) {
      expect(built).not.toHaveProperty(key)
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("lockTimeout"))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("retention"))
  })

  it("shallow-merges the deprecated bullWorkerOptions under top-level options", () => {
    const built = buildWorkerOptions({
      connection: { host: "localhost" },
      concurrency: 9,
      bullWorkerOptions: { concurrency: 3, stalledInterval: 15_000 },
    })
    expect(built.concurrency).toBe(9) // top level wins
    expect(built.stalledInterval).toBe(15_000) // escape-hatch extras survive
  })

  it("warns once per option, not per call", () => {
    const options = { connection: { host: "localhost" }, lockTimeout: "5m" as const }
    buildWorkerOptions(options)
    buildWorkerOptions(options)
    const lockWarns = vi
      .mocked(console.warn)
      .mock.calls.filter(([msg]) => String(msg).includes("lockTimeout"))
    expect(lockWarns).toHaveLength(1)
  })

  it("maps bullPrefix to prefix and strips durable-only fields (queue)", () => {
    const built = buildQueueOptions({
      connection: { host: "localhost" },
      bullPrefix: "legacy-bull",
      durablePrefix: "durable",
      resumeAttempts: 3,
      defaultJobOptions: { keepLogs: 100 },
    })
    expect(built.prefix).toBe("legacy-bull")
    expect(built.defaultJobOptions).toEqual({ keepLogs: 100 })
    for (const key of ["durablePrefix", "stateStore", "bullPrefix", "resumeAttempts"]) {
      expect(built).not.toHaveProperty(key)
    }
  })

  it("prefers the new prefix over the deprecated alias", () => {
    const built = buildQueueOptions({
      connection: { host: "localhost" },
      prefix: "new",
      bullPrefix: "old",
    })
    expect(built.prefix).toBe("new")
  })
})
