/**
 * Project Order -- the persistent sidebar structure: the project/group tree plus
 * the workspace tier (`workspaces` + per-workspace trees).
 *
 * PER USER. Each user owns a row at `project-order:<user>`; nobody sees anyone
 * else's tabs or grouping. The pre-per-user shared row (`project-order`) is the
 * SEED: a user with no row of their own starts from it, and forks on first write.
 * The seed row is never written again, so it stays a stable starting point.
 *
 * Leaf node IDs are canonical project URIs (`claude://default/path`); legacy
 * `cwd:<path>` IDs migrate on load. Normalization lives in
 * project-order-normalize.ts; owner resolution in project-order-owner.ts.
 */

import type { ProjectOrder } from '../shared/project-order-types'
import { isLegacyFormat, normalize } from './project-order-normalize'
import type { KVStore } from './store/types'

// Types live in the shared module so the broker + web never drift. Only
// ProjectOrder is re-exported (the rest are imported where consumers use them
// directly from the shared module).
export type { ProjectOrder } from '../shared/project-order-types'

/** Pre-per-user row. Read-only seed once a user has their own row. */
const SEED_KEY = 'project-order'
const keyFor = (user: string) => `project-order:${user}`

let kv: KVStore | null = null
/** userId -> that user's order. Populated lazily on first read. */
const cache = new Map<string, ProjectOrder>()

const EMPTY: ProjectOrder = { tree: [] }

export function initProjectOrder(store: KVStore): void {
  kv = store
  cache.clear()
}

/** Read + normalize one KV row. Re-saves in place when the stored shape was
 *  legacy, so the migration happens once rather than on every read. */
function loadRow(key: string, persistMigration: boolean): ProjectOrder | null {
  if (!kv) return null
  const raw = kv.get<Record<string, unknown>>(key)
  if (!raw) return null
  try {
    const { order, migrated } = normalize(raw)
    if (persistMigration && (isLegacyFormat(raw) || migrated)) kv.set(key, order)
    return order
  } catch {
    return EMPTY
  }
}

/**
 * A user's order. Falls back to the shared seed row for a user who has never
 * saved -- so nobody lands on an empty sidebar the first time they log in after
 * the per-user cutover.
 */
export function getProjectOrder(user: string): ProjectOrder {
  const cached = cache.get(user)
  if (cached) return cached
  const own = loadRow(keyFor(user), true)
  // The seed is normalized but NOT re-saved under its own key: it stays the
  // untouched starting point for every user who has not forked yet.
  const order = own ?? loadRow(SEED_KEY, false) ?? EMPTY
  cache.set(user, order)
  return order
}

/**
 * Merge a partial update onto the user's stored order: a field the writer
 * OMITTED means "leave it alone", never "delete it".
 *
 * This exists because the control panel has writers that predate workspaces --
 * "Move to group", "Rename group", the Organize Projects modal -- and each
 * rebuilds a bare `{ tree }`. Under the old wholesale replace, every one of
 * those group operations silently destroyed `workspaces` + `workspaceTrees`
 * (the 2026-07-28 wipe, unrecoverable from backups).
 *
 * Deleting is still possible, it just has to be deliberate: send an explicit
 * empty `[]` / `{}`. Note that `undefined` does NOT survive JSON transport, so
 * a key-presence check would read "explicitly cleared" as "omitted" on the wire
 * -- explicit-empty is the only delete signal that crosses the socket intact.
 */
function mergeOntoStored(update: ProjectOrder, stored: ProjectOrder): ProjectOrder {
  return {
    ...update,
    workspaces: update.workspaces ?? stored.workspaces,
    workspaceTrees: update.workspaceTrees ?? stored.workspaceTrees,
  }
}

export function setProjectOrder(user: string, update: ProjectOrder): void {
  if (!update || !Array.isArray(update.tree)) return
  const { order } = normalize(mergeOntoStored(update, getProjectOrder(user)))
  cache.set(user, order)
  kv?.set(keyFor(user), order)
}
