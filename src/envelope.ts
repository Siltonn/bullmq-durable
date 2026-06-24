/**
 * Resume-job envelopes.
 *
 * A durable instance outlives a single BullMQ job. When the runtime schedules a
 * resume tick it enqueues a *new* BullMQ job (with a new id), so it must carry
 * the original instance id alongside the user payload. That is done with a tiny
 * envelope keyed by a reserved field; the worker unwraps it before handing the
 * job to the processor, so user code only ever sees its own payload.
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
