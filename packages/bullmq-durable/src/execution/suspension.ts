/**
 * {@link SuspensionController} — the single owner of the "we must wait" decision.
 *
 * Every wait in a tick funnels through here, so the mode split lives in ONE
 * place instead of scattered `if (mode === "settle")` checks:
 *  - `"normal"`: record the resume request and unwind the processor with a
 *    {@link DurableYieldError} — the runtime turns it into `moveToDelayed` on
 *    the run's own job.
 *  - `"settle"`: there is no job left to delay. A backoff waits in-process
 *    (settlement work is compensation-sized); a sleep — or any outright
 *    suspension — is rejected rather than silently blocking.
 */

import { DurableYieldError } from "../errors"

/**
 * `"normal"` — a live tick on the run's own job (suspensions moveToDelayed).
 * `"settle"` — a post-mortem tick from the `failed`-event listener: the forward
 * phase is replay-only (no side effects), and compensation retries wait
 * in-process because there is no job left to delay.
 */
export type RunMode = "normal" | "settle"

/** The suspension recorded by the last yield: how long until re-delivery. */
export interface PendingResume {
  delayMs: number
  reason: string
}

export class SuspensionController {
  /**
   * The suspension recorded by yields this tick. Concurrent steps may each
   * yield; the EARLIEST due time wins (every path replays on resume anyway).
   * The runtime reads it after the processor unwinds and turns it into
   * `moveToDelayed`.
   */
  private pendingResume?: PendingResume

  constructor(
    private readonly mode: RunMode,
    private readonly sleepInProcess: (ms: number) => Promise<void> = sleepFor,
  ) {}

  /** Hand the recorded resume request (if any) to the runtime, clearing it. */
  takePendingResume(): PendingResume | undefined {
    const resume = this.pendingResume
    this.pendingResume = undefined
    return resume
  }

  /**
   * Wait for `delayMs`, however this mode waits: normal yields to BullMQ;
   * settlement waits a backoff in-process and refuses to sleep.
   */
  async waitOrYield(kind: "sleep" | "backoff", delayMs: number, reason: string): Promise<void> {
    if (this.mode === "settle") {
      if (kind === "sleep") {
        throw new Error(
          "bullmq-durable: ctx.sleep is not supported during stall settlement — " +
            "settlement compensations must not sleep",
        )
      }
      await this.sleepInProcess(delayMs)
      return
    }
    this.yieldToBullMQ(delayMs, reason)
  }

  /**
   * Record the resume request, then unwind the processor with a
   * {@link DurableYieldError}. Concurrent yields keep the EARLIEST due time.
   * Never returns.
   */
  yieldToBullMQ(delayMs: number, reason: string): never {
    if (this.mode === "settle") {
      throw new Error("bullmq-durable: cannot suspend during stall settlement (no job to delay)")
    }
    if (!this.pendingResume || delayMs < this.pendingResume.delayMs) {
      this.pendingResume = { delayMs, reason }
    }
    throw new DurableYieldError(reason)
  }
}

/** Unref'd in-process wait (settlement backoffs must not pin the process). */
function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
