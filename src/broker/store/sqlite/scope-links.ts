import type { Database } from 'bun:sqlite'
import type { ScopeLink, ScopeLinkStore } from '../types'

function canonicalize(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function rowToLink(row: Record<string, string | number | null>): ScopeLink {
  return {
    scopeA: row.scope_a as string,
    scopeB: row.scope_b as string,
    status: row.status as ScopeLink['status'],
    createdAt: row.created_at as number,
  }
}

export function createSqliteScopeLinkStore(db: Database): ScopeLinkStore {
  const stmtGet = db.prepare('SELECT * FROM scope_links WHERE scope_a = $scopeA AND scope_b = $scopeB')
  const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO scope_links (scope_a, scope_b, status, created_at)
    VALUES ($scopeA, $scopeB, 'active', $createdAt)
  `)
  const stmtDelete = db.prepare('DELETE FROM scope_links WHERE scope_a = $scopeA AND scope_b = $scopeB')
  const stmtSetStatus = db.prepare(
    'UPDATE scope_links SET status = $status WHERE scope_a = $scopeA AND scope_b = $scopeB',
  )
  const stmtLinksFor = db.prepare('SELECT * FROM scope_links WHERE scope_a = $scope OR scope_b = $scope')

  return {
    link(scopeA, scopeB) {
      const [a, b] = canonicalize(scopeA, scopeB)
      stmtInsert.run({ scopeA: a, scopeB: b, createdAt: Date.now() })
    },

    unlink(scopeA, scopeB) {
      const [a, b] = canonicalize(scopeA, scopeB)
      stmtDelete.run({ scopeA: a, scopeB: b })
    },

    getStatus(scopeA, scopeB) {
      const [a, b] = canonicalize(scopeA, scopeB)
      const row = stmtGet.get({ scopeA: a, scopeB: b }) as Record<string, string | number | null> | null
      return (row?.status as ScopeLink['status']) ?? null
    },

    setStatus(scopeA, scopeB, status) {
      const [a, b] = canonicalize(scopeA, scopeB)
      stmtSetStatus.run({ scopeA: a, scopeB: b, status })
    },

    listLinksFor(scope) {
      const rows = stmtLinksFor.all({ scope }) as Record<string, string | number | null>[]
      return rows.map(rowToLink)
    },
  }
}
