import { describe, expect, it } from "vitest"
import { isDurationLike, parseDuration } from "../src/utils/duration"

describe("parseDuration", () => {
  it("treats numbers as milliseconds", () => {
    expect(parseDuration(0)).toBe(0)
    expect(parseDuration(1500)).toBe(1500)
    expect(parseDuration(10.7)).toBe(11) // rounded
  })

  it("parses unit strings", () => {
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("10s")).toBe(10_000)
    expect(parseDuration("5m")).toBe(300_000)
    expect(parseDuration("2h")).toBe(7_200_000)
    expect(parseDuration("1d")).toBe(86_400_000)
    expect(parseDuration("1w")).toBe(604_800_000)
  })

  it("parses fractional and whitespaced values", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000)
    expect(parseDuration("10 s")).toBe(10_000)
    expect(parseDuration("250")).toBe(250) // bare number => ms
  })

  it("rejects negative or invalid input", () => {
    expect(() => parseDuration(-1)).toThrow()
    expect(() => parseDuration("soon")).toThrow()
    expect(() => parseDuration("10 years")).toThrow()
    expect(() => parseDuration(Number.NaN)).toThrow()
  })
})

describe("isDurationLike", () => {
  it("accepts non-negative numbers and unit strings", () => {
    expect(isDurationLike(0)).toBe(true)
    expect(isDurationLike(1000)).toBe(true)
    expect(isDurationLike("10s")).toBe(true)
    expect(isDurationLike("250")).toBe(true)
  })

  it("rejects reasons and invalid values", () => {
    expect(isDurationLike("still pending")).toBe(false)
    expect(isDurationLike(-5)).toBe(false)
    expect(isDurationLike(undefined)).toBe(false)
    expect(isDurationLike({})).toBe(false)
  })
})
