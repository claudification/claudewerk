/**
 * The stats store's one database handle.
 *
 * It lives here rather than in `store.ts` so that `read.ts` and `retention.ts`
 * can reach it without importing the writer, and the writer can start the
 * retention sweep without importing the reader. One tiny module breaks a cycle
 * three files would otherwise have.
 *
 * `null` is the normal state, not an error: a unit test, the CLI, or anything
 * that imports a wall producer without booting a broker never calls
 * `initStatsStore()`, and every entry point degrades to a no-op rather than
 * throwing. Stats accounting must never be the reason something else fails.
 */

import type { Database } from 'bun:sqlite'

let handle: Database | null = null

export function setStatsDb(db: Database | null): void {
  handle = db
}

export function statsDb(): Database | null {
  return handle
}
