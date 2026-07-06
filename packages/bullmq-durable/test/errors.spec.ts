import { UnrecoverableError } from "bullmq"
import { describe, expect, it } from "vitest"
import {
  DurableActionError,
  DurableCancelledError,
  DurableCancelledJobError,
  DurableError,
  DurableNonRetryableError,
  DurableRetriesExhaustedError,
  DurableTerminalJobError,
  DurableYieldError,
  isDurableBoundaryError,
  isStepFailure,
  markStepFailure,
  RetryLaterError,
  SettleIncompleteError,
} from "../src/errors"

describe("durable errors", () => {
  it("every non-boundary error inherits DurableError with a correct name", () => {
    const errors = [
      new DurableYieldError("sleep"),
      new RetryLaterError(1000, "pending"),
      new DurableNonRetryableError("bad"),
      new DurableCancelledError("gen:1"),
      new DurableRetriesExhaustedError("step", 3),
      new SettleIncompleteError("charge"),
      new DurableActionError("nope", "not_found"),
    ]
    for (const error of errors) {
      expect(error).toBeInstanceOf(DurableError)
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe(error.constructor.name)
    }
  })

  it("boundary errors extend BullMQ's UnrecoverableError (not DurableError)", () => {
    const boundary = [
      new DurableTerminalJobError("settled", new Error("x")),
      new DurableCancelledJobError("gen:1"),
    ]
    for (const error of boundary) {
      expect(error).toBeInstanceOf(UnrecoverableError)
      expect(error).not.toBeInstanceOf(DurableError)
      expect(error.name).toBe(error.constructor.name)
    }
  })

  it("carry their structured fields", () => {
    expect(new RetryLaterError(5_000, "pending").delayMs).toBe(5_000)
    expect(new RetryLaterError().delayMs).toBeUndefined()
    expect(new DurableCancelledError("gen:1").instanceId).toBe("gen:1")
    expect(new DurableRetriesExhaustedError("poll", 4).attempts).toBe(4)
    expect(new SettleIncompleteError("charge").stepKey).toBe("charge")
    expect(new DurableActionError("x", "invalid_state").code).toBe("invalid_state")
    expect(new DurableTerminalJobError("t", "cause").cause).toBe("cause")
  })

  it("recognises boundary errors across module-instance boundaries", () => {
    // Real instances: instanceof path.
    expect(isDurableBoundaryError(new DurableTerminalJobError("settled"))).toBe(true)
    expect(isDurableBoundaryError(new DurableCancelledJobError("q:1"))).toBe(true)

    // A duplicated bullmq-durable copy: instanceof fails, but the error still
    // carries the same class name (and the Symbol.for marker) — simulate with
    // a foreign Error wearing the name.
    const foreign = new Error("settled")
    foreign.name = "DurableTerminalJobError"
    expect(isDurableBoundaryError(foreign)).toBe(true)

    // The marker alone is enough (name mangled by a subclass).
    const marked = new Error("renamed")
    Object.defineProperty(marked, Symbol.for("bullmq-durable:boundary-error"), { value: true })
    expect(isDurableBoundaryError(marked)).toBe(true)

    // NOT boundary: plain errors, and crucially BullMQ's own stall
    // UnrecoverableError — that one MUST still trigger the settle tick.
    expect(isDurableBoundaryError(new Error("x"))).toBe(false)
    expect(isDurableBoundaryError(new UnrecoverableError("job stalled"))).toBe(false)
    expect(isDurableBoundaryError(null)).toBe(false)
  })

  it("marks and recognises settled step failures by identity", () => {
    const settled = markStepFailure(new Error("card declined"))
    expect(isStepFailure(settled)).toBe(true)
    expect(isStepFailure(new Error("card declined"))).toBe(false) // same shape, no identity
    expect(isStepFailure(markStepFailure("primitive"))).toBe(false) // no-op on primitives
    expect(isStepFailure(null)).toBe(false)
  })
})
