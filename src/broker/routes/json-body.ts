/**
 * Parse-and-validate the JSON body of a POST route.
 *
 * Every substrate route opens with the same eight lines: try/catch the JSON,
 * then check the required fields, then 400 twice with different text. Two of
 * them already carry a `fallow-ignore code-duplication` over that block.
 *
 * The `validate` callback returns the ERROR MESSAGE or null, rather than a
 * boolean, so a route can say which field is missing instead of emitting one
 * catch-all string for six different mistakes.
 */

import type { Context } from 'hono'

export type BodyValidator<T> = (body: T) => string | null

export type ParsedBody<Ready> = { body: Ready } | { error: string }

/**
 * Returns the parsed body, or the message the caller should 400 with. Never
 * throws: a malformed body is an expected client mistake, not an exception.
 *
 * `Ready` is the shape the body has ONCE VALIDATED -- usually the wire type with
 * its required fields made non-optional. The single cast below is what the
 * validator buys; putting it here means each route does not repeat it, and
 * a route whose `Ready` claims more than its validator checks is the one way to
 * get this wrong.
 */
export async function readJsonBody<T extends object, Ready = T>(
  c: Context,
  validate: BodyValidator<T>,
): Promise<ParsedBody<Ready>> {
  let body: T
  try {
    body = await c.req.json<T>()
  } catch {
    return { error: 'invalid JSON body' }
  }
  if (!body || typeof body !== 'object') return { error: 'invalid JSON body' }
  const problem = validate(body)
  return problem ? { error: problem } : { body: body as unknown as Ready }
}
