/**
 * Reusable WHERE fragments for the store's SQL builders.
 *
 * Every one of these appends to a SQL string and binds into a params bag. They
 * take a column prefix because callers differ on aliasing -- `transcript_fts`
 * joins force `t.type`, a plain single-table select wants bare `type`.
 */

export type SqlParams = Record<string, string | number | bigint | boolean | null>

/** `AND <prefix>type IN (...)`, or nothing when the filter is absent/empty. */
export function appendTypeFilter(sql: string, params: SqlParams, types: string[] | undefined, prefix = ''): string {
  if (!types?.length) return sql
  const placeholders = types.map((_, i) => `$type${i}`)
  for (let i = 0; i < types.length; i++) params[`type${i}`] = types[i]
  return `${sql} AND ${prefix}type IN (${placeholders.join(', ')})`
}

/** `AND <prefix>conversation_id IN (...)`, or nothing when the list is absent/empty. */
export function appendConversationIdsFilter(
  sql: string,
  params: SqlParams,
  conversationIds: string[] | undefined,
  prefix = '',
): string {
  if (!conversationIds?.length) return sql
  const placeholders = conversationIds.map((_, i) => `$cid${i}`)
  for (let i = 0; i < conversationIds.length; i++) params[`cid${i}`] = conversationIds[i]
  return `${sql} AND ${prefix}conversation_id IN (${placeholders.join(', ')})`
}
