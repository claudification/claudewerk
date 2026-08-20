/**
 * The two one-line statement runners every sqlite store module reaches for.
 *
 * They exist as a shared pair because the `binds ? ... : ...` split is not
 * optional decoration: `bun:sqlite` binds a bare-key object as SILENT NULL
 * unless the database was opened `{strict: true}`, and passing an `undefined`
 * bag through `.all(binds)` is a different call than `.all()`. Two copies of
 * that rule drift; one copy is the rule.
 */

import type { Database } from 'bun:sqlite'

export type Binds = Record<string, string | number | null>

export function queryAll(db: Database, sql: string, binds?: Binds): unknown[] {
  const stmt = db.query(sql)
  return binds ? stmt.all(binds as never) : stmt.all()
}

export function queryGet(db: Database, sql: string, binds?: Binds): unknown {
  const stmt = db.query(sql)
  return binds ? stmt.get(binds as never) : stmt.get()
}
