import { describe, expect, it } from "vitest"
import { DurableNonRetryableError } from "../src/errors"
import { cloneValue, deserializeError, safeStringify, serializeError } from "../src/utils/serialize"

describe("serializeError", () => {
  it("captures name, message, and stack of real errors", () => {
    const error = new TypeError("boom")
    const serialized = serializeError(error)
    expect(serialized.name).toBe("TypeError")
    expect(serialized.message).toBe("boom")
    expect(serialized.stack).toContain("boom")
  })

  it("preserves a custom error subclass name", () => {
    const serialized = serializeError(new DurableNonRetryableError("nope"))
    expect(serialized.name).toBe("DurableNonRetryableError")
    expect(serialized.message).toBe("nope")
  })

  it("preserves a `code` property", () => {
    const error = Object.assign(new Error("fail"), { code: "ECONN" })
    expect(serializeError(error).code).toBe("ECONN")
  })

  it("handles non-Error throwables", () => {
    expect(serializeError("just a string")).toEqual({ name: "Error", message: "just a string" })
    expect(serializeError({ weird: true }).name).toBe("NonError")
  })
})

describe("deserializeError", () => {
  it("round-trips back into a throwable Error", () => {
    const original = new RangeError("out of range")
    const restored = deserializeError(serializeError(original))
    expect(restored).toBeInstanceOf(Error)
    expect(restored.name).toBe("RangeError")
    expect(restored.message).toBe("out of range")
  })
})

describe("cloneValue", () => {
  it("deep clones serialisable values", () => {
    const source = { a: 1, nested: { b: [1, 2, 3] } }
    const clone = cloneValue(source)
    expect(clone).toEqual(source)
    expect(clone).not.toBe(source)
    expect(clone.nested).not.toBe(source.nested)
  })

  it("preserves undefined", () => {
    expect(cloneValue(undefined)).toBeUndefined()
  })
})

describe("safeStringify", () => {
  it("does not throw on circular references", () => {
    const circular: Record<string, unknown> = { name: "root" }
    circular.self = circular
    const output = safeStringify(circular)
    expect(output).toContain("root")
    expect(output).toContain("[Circular]")
  })
})
