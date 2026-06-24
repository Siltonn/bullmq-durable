import { describe, expect, it } from "vitest"
import { isResumeEnvelope, unwrapResumeData, wrapResumeData } from "../src/envelope"

describe("resume envelope", () => {
  it("wraps and unwraps a payload with durable metadata", () => {
    const envelope = wrapResumeData({ userId: "u1" }, "gen:1", "1", 2)
    expect(isResumeEnvelope(envelope)).toBe(true)

    const { meta, payload } = unwrapResumeData(envelope)
    expect(meta).toEqual({ instanceId: "gen:1", originalJobId: "1", resumeSeq: 2 })
    expect(payload).toEqual({ userId: "u1" })
  })

  it("treats plain job data as a non-envelope payload", () => {
    expect(isResumeEnvelope({ userId: "u1" })).toBe(false)
    expect(isResumeEnvelope("a string")).toBe(false)
    expect(isResumeEnvelope(null)).toBe(false)

    const { meta, payload } = unwrapResumeData({ userId: "u1" })
    expect(meta).toBeUndefined()
    expect(payload).toEqual({ userId: "u1" })
  })

  it("preserves primitive payloads through the envelope", () => {
    const envelope = wrapResumeData("just-a-string", "gen:1", "1", 1)
    expect(unwrapResumeData(envelope).payload).toBe("just-a-string")
  })
})
