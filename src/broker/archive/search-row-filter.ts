/** The per-line hot path of a cold search.
 *
 *  Runs on every line of every month in scope -- tens of millions of times on a
 *  full-history scan -- so the order is the whole design: the cheapest test that
 *  can reject a line runs first, and `JSON.parse` only happens for a line that
 *  already looks like a hit.
 */

import type { Matcher } from './search-match'

export interface RowFilterOptions {
  matcher: Matcher
  types?: string[]
  conversationId?: string
}

export type RowFilter = (line: string) => Record<string, unknown> | null

export function makeRowFilter({ matcher, types, conversationId }: RowFilterOptions): RowFilter {
  // Raw-line prefilter for the type, so a filtered search skips the parse on
  // rows it would only discard. Confirmed against the parsed row afterwards,
  // since `"type":"user"` can also appear inside a quoted tool payload.
  const typeNeedles = types?.length ? types.map(t => `"type":"${t}"`) : null
  const typeSet = types?.length ? new Set(types) : null

  return line => {
    if (typeNeedles && !typeNeedles.some(n => line.includes(n))) return null
    if (!matcher.test(line)) return null

    const row = JSON.parse(line) as Record<string, unknown>
    if (typeSet && !typeSet.has(String(row.type))) return null
    if (conversationId && row.conversation_id !== conversationId) return null
    return row
  }
}
