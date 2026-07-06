import { describe, expect, it } from "vitest"
import type { DurableLogEntry } from "../src/index"
import {
  DURABLE_LOG_MARKER,
  MAX_LOG_ENTRY_BYTES,
  parseJobLogs,
  parseLogLine,
  serializeLogEntry,
} from "../src/utils/log"

describe("durable log lines", () => {
  it("round-trips a structured entry through the wire format", () => {
    const entry: DurableLogEntry = {
      message: "charging card",
      timestamp: 1719873420000,
      kind: "log",
      runCount: 3,
      jobAttempt: 1,
      step: "charge-card",
      stepAttempt: 2,
      meta: { orderId: "o_1" },
    }
    const line = serializeLogEntry(entry)
    expect(JSON.parse(line)[DURABLE_LOG_MARKER]).toBe(1)
    expect(parseLogLine(line)).toEqual(entry)
  })

  it("wraps foreign job.log lines as raw entries instead of failing", () => {
    expect(parseLogLine("plain text from user code")).toEqual({
      kind: "raw",
      message: "plain text from user code",
      timestamp: 0,
    })
    // JSON, but not ours.
    expect(parseLogLine('{"level":"info","msg":"other tool"}').kind).toBe("raw")
    // Corrupt JSON that merely starts with '{'.
    expect(parseLogLine("{broken").kind).toBe("raw")
  })

  it("parses a mixed job-log listing", () => {
    const lines = [
      serializeLogEntry({ message: "ours", timestamp: 1, kind: "log" }),
      "someone else's line",
    ]
    const parsed = parseJobLogs(lines)
    expect(parsed[0]?.kind).toBe("log")
    expect(parsed[1]?.kind).toBe("raw")
  })

  it("truncates oversized meta instead of storing a mega-entry", () => {
    const line = serializeLogEntry({
      message: "big",
      timestamp: 1,
      kind: "log",
      meta: { blob: "x".repeat(MAX_LOG_ENTRY_BYTES * 2) },
    })
    expect(line.length).toBeLessThan(MAX_LOG_ENTRY_BYTES)
    expect(parseLogLine(line).meta).toEqual({ $truncated: true })
  })
})
