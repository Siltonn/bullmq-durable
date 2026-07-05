/**
 * LEGACY (0.1.x) resume-job envelopes — kept only as a rolling-upgrade shim.
 *
 * 0.1.x advanced a run by enqueuing new "resume" jobs whose data wrapped the
 * user payload with durable metadata. 0.2.0 has no resume jobs (a run rides one
 * BullMQ job via `moveToDelayed`), but an upgraded worker may still receive
 * in-flight 0.1.x resume jobs — some sleep for days. The worker detects the
 * envelope, unwraps it, and keeps advancing the ORIGINAL instance; the legacy
 * job simply becomes the run's carrier under the new mechanics.
 *
 * @deprecated Internal shim. Not exported from the package root. Removed in 0.3.0.
 */

/** Reserved key used to carry durable metadata on resume jobs. */
export const DURABLE_META_KEY = "__durable__"

export interface DurableMeta {
  instanceId: string
  originalJobId: string
  resumeSeq: number
}

export interface ResumeEnvelope {
  [DURABLE_META_KEY]: DurableMeta
  payload: unknown
}

/** Wrap a user payload with durable metadata for a resume job. */
export function wrapResumeData(
  payload: unknown,
  instanceId: string,
  originalJobId: string,
  resumeSeq: number,
): ResumeEnvelope {
  return {
    [DURABLE_META_KEY]: { instanceId, originalJobId, resumeSeq },
    payload,
  }
}

/** Detect whether some BullMQ `job.data` is a resume envelope. */
export function isResumeEnvelope(data: unknown): data is ResumeEnvelope {
  if (typeof data !== "object" || data === null) return false
  if (!(DURABLE_META_KEY in data) || !("payload" in data)) return false
  // Validate the metadata shape too, so a user payload that merely happens to
  // have `__durable__` / `payload` keys is not mistaken for a resume envelope.
  const meta = (data as Record<string, unknown>)[DURABLE_META_KEY]
  return (
    typeof meta === "object" &&
    meta !== null &&
    typeof (meta as DurableMeta).instanceId === "string" &&
    typeof (meta as DurableMeta).originalJobId === "string" &&
    typeof (meta as DurableMeta).resumeSeq === "number"
  )
}

/** Split a job's data into durable metadata (if any) and the user payload. */
export function unwrapResumeData(data: unknown): { meta?: DurableMeta; payload: unknown } {
  if (isResumeEnvelope(data)) {
    return { meta: data[DURABLE_META_KEY], payload: data.payload }
  }
  return { payload: data }
}
