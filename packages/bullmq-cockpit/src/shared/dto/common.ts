/** Shared primitives used across every wire contract. */

/** A plain, JSON-serialisable representation of a thrown error. */
export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string | number
}

/** A page of results, mirroring the inspector pagination contract. */
export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** The result of a mutating action (retry / resume / cancel / …). */
export interface ActionResult {
  ok: boolean
  message?: string
  /** Id of a created/affected entity, when relevant (e.g. a new alert rule). */
  id?: string
}
