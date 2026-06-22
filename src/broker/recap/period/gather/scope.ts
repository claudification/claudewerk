import type { StoreDriver } from '../../../store/types'

/**
 * Resolve a recap `projectUri` into the concrete list of project scopes to
 * gather conversations (and every other per-project signal) from.
 *
 * The cross-project sentinel `'*'` (an "all projects" recap) expands to EVERY
 * distinct project scope in the store. It must NOT be passed through literally:
 * the gather layer turns each scope into a `WHERE scope = ?` filter, and no
 * conversation's `scope` column is ever the literal `'*'`, so a literal `'*'`
 * matched nothing and the whole cross-project recap came back empty.
 *
 * A concrete URI passes through (optionally expanded to its worktree-child
 * rollup via `expand`).
 */
export function resolveProjectScope(
  store: StoreDriver,
  projectUri: string,
  expand?: (projectUri: string) => string[],
): string[] {
  if (projectUri === '*') return store.conversations.listScopes()
  return (expand ?? (p => [p]))(projectUri)
}
