/**
 * A tiny typed HTTP error. Routes throw these and a single Hono `onError`
 * handler turns them into JSON responses, so route bodies stay focused on the
 * happy path.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, message, "bad_request")

export const forbidden = (message = "Forbidden"): HttpError =>
  new HttpError(403, message, "forbidden")

export const notFound = (message = "Not found"): HttpError =>
  new HttpError(404, message, "not_found")

/** Raised when a mutating action is attempted while the cockpit is read-only. */
export const readonly = (): HttpError =>
  new HttpError(403, "bullmq-cockpit is running in read-only mode", "readonly")
