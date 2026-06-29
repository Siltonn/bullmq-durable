import { describe, expect, it } from "vitest"
import {
  DurableCancelledError,
  DurableError,
  DurableNonRetryableError,
  DurableRetriesExhaustedError,
  DurableTimeoutError,
  DurableYieldError,
  isRetryLaterError,
  isYieldError,
  RetryLaterError,
} from "../src/errors"

describe("durable errors", () => {
  it("set a correct name and inherit from DurableError", () => {
    const errors = [
      new DurableYieldError("sleep"),
      new RetryLaterError(1000, "pending"),
      new DurableNonRetryableError("bad"),
      new DurableCancelledError("gen:1"),
      new DurableRetriesExhaustedError("step", 3),
      new DurableTimeoutError("too slow"),
    ]
    for (const error of errors) {
      expect(error).toBeInstanceOf(DurableError)
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe(error.constructor.name)
    }
  })

  it("carry their structured fields", () => {
    expect(new RetryLaterError(5_000, "pending").delayMs).toBe(5_000)
    expect(new RetryLaterError().delayMs).toBeUndefined()
    expect(new DurableCancelledError("gen:1").instanceId).toBe("gen:1")
    expect(new DurableRetriesExhaustedError("poll", 4).attempts).toBe(4)
  })

  it("are recognised by their type guards", () => {
    expect(isYieldError(new DurableYieldError())).toBe(true)
    expect(isYieldError(new Error("x"))).toBe(false)
    expect(isRetryLaterError(new RetryLaterError())).toBe(true)
    expect(isRetryLaterError(new DurableYieldError())).toBe(false)
  })
})
