/**
 * Thin Zod-on-Hono helpers. They turn a validation failure into a `400` with a
 * readable message, so routes can treat parsing as "succeed or throw".
 */

import type { Context } from "hono"
import type { z } from "zod"
import { badRequest } from "./http-error"

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".")
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join("; ")
}

/** Validate the query string against `schema`, or throw a `400`. */
export function parseQuery<T extends z.ZodTypeAny>(schema: T, c: Context): z.infer<T> {
  const result = schema.safeParse(c.req.query())
  if (!result.success) throw badRequest(formatIssues(result.error))
  return result.data
}

/** Validate the JSON body against `schema` (empty body → `{}`), or throw a `400`. */
export async function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  c: Context,
): Promise<z.infer<T>> {
  const body = await c.req.json().catch(() => ({}))
  const result = schema.safeParse(body)
  if (!result.success) throw badRequest(formatIssues(result.error))
  return result.data
}
