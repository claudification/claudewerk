import type { Database } from 'bun:sqlite'
import type { AddressBookStore, AddressEntry } from '../types'

function rowToEntry(row: Record<string, string | number | null>): AddressEntry {
  return {
    ownerScope: row.owner_scope as string,
    slug: row.slug as string,
    targetScope: row.target_scope as string,
    createdAt: row.created_at as number,
    lastUsed: (row.last_used as number) ?? undefined,
  }
}

export function createSqliteAddressBookStore(db: Database): AddressBookStore {
  const stmtGet = db.prepare('SELECT * FROM address_book WHERE owner_scope = $ownerScope AND slug = $slug')
  const stmtUpsert = db.prepare(`
    INSERT INTO address_book (owner_scope, slug, target_scope, created_at, last_used)
    VALUES ($ownerScope, $slug, $targetScope, $createdAt, $lastUsed)
    ON CONFLICT(owner_scope, slug) DO UPDATE SET target_scope = $targetScope
  `)
  const stmtUpdateLastUsed = db.prepare(
    'UPDATE address_book SET last_used = $lastUsed WHERE owner_scope = $ownerScope AND slug = $slug',
  )
  const stmtDelete = db.prepare('DELETE FROM address_book WHERE owner_scope = $ownerScope AND slug = $slug')
  const stmtForScope = db.prepare('SELECT * FROM address_book WHERE owner_scope = $ownerScope')
  const stmtByTarget = db.prepare('SELECT * FROM address_book WHERE target_scope = $targetScope')

  return {
    resolve(ownerScope, slug) {
      const row = stmtGet.get({ ownerScope, slug }) as Record<string, string | number | null> | null
      if (row) {
        stmtUpdateLastUsed.run({ ownerScope, slug, lastUsed: Date.now() })
        return row.target_scope as string
      }
      return null
    },

    set(ownerScope, slug, targetScope) {
      const existing = stmtGet.get({ ownerScope, slug }) as Record<string, string | number | null> | null
      stmtUpsert.run({
        ownerScope,
        slug,
        targetScope,
        createdAt: existing ? (existing.created_at as number) : Date.now(),
        lastUsed: existing ? (existing.last_used as number | null) : null,
      })
    },

    delete(ownerScope, slug) {
      const result = stmtDelete.run({ ownerScope, slug })
      return result.changes > 0
    },

    listForScope(ownerScope) {
      const rows = stmtForScope.all({ ownerScope }) as Record<string, string | number | null>[]
      return rows.map(rowToEntry)
    },

    findByTarget(targetScope) {
      const rows = stmtByTarget.all({ targetScope }) as Record<string, string | number | null>[]
      return rows.map(rowToEntry)
    },
  }
}
