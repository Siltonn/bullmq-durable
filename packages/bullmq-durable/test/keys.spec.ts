import { describe, expect, it } from "vitest"
import {
  createInstanceId,
  DEFAULT_DURABLE_PREFIX,
  instanceKey,
  lockKey,
  logsKey,
  resumeJobId,
  stepIdOf,
  stepsKey,
} from "../src/utils/keys"

describe("key builders", () => {
  it("derives a stable instance id from queue + job id", () => {
    expect(createInstanceId("generation", "123")).toBe("generation:123")
    expect(createInstanceId("generation", 7)).toBe("generation:7")
  })

  it("builds namespaced redis keys", () => {
    const id = "generation:123"
    expect(instanceKey(DEFAULT_DURABLE_PREFIX, id)).toBe("bullmq-durable:instance:generation:123")
    expect(stepsKey("p", id)).toBe("p:steps:generation:123")
    expect(logsKey("p", id)).toBe("p:logs:generation:123")
    expect(lockKey("p", id)).toBe("p:lock:generation:123")
  })

  it("keeps the instance id as the trailing segment so keys cannot cross-collide", () => {
    // With the discriminator (`instance`/`steps`/`logs`) before the id, one
    // instance's hash can never land on another's steps/logs key — even when an
    // instance id ends in ":steps".
    expect(instanceKey("p", "q:1:steps")).not.toBe(stepsKey("p", "q:1"))
    expect(instanceKey("p", "q:1:logs")).not.toBe(logsKey("p", "q:1"))
  })

  it("builds idempotency-friendly step ids", () => {
    expect(stepIdOf("generation:123", "deduct-credits")).toBe("generation:123:deduct-credits")
  })

  it("builds unique resume job ids per sequence", () => {
    expect(resumeJobId("123", 1)).toBe("123:resume:1")
    expect(resumeJobId("123", 2)).toBe("123:resume:2")
  })
})
