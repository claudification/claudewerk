import type { Database } from 'bun:sqlite'
import type { KVStore } from '../types'

export function createSqliteKVStore(db: Database): KVStore {
  const stmtGet = db.prepare('SELECT value FROM kv WHERE key = $key')
  const stmtUpsert = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES ($key, $value)')
  const stmtDelete = db.prepare('DELETE FROM kv WHERE key = $key')
  const stmtAllKeys = db.prepare('SELECT key FROM kv')
  const stmtKeysByPrefix = db.prepare("SELECT key FROM kv WHERE key LIKE $prefix || '%'")

  return {
    get<T = unknown>(key: string): T | null {
      const row = stmtGet.get({ key }) as { value: string } | null
      if (!row) return null
      return JSON.parse(row.value) as T
    },

    set<T = unknown>(key: string, value: T) {
      stmtUpsert.run({ key, value: JSON.stringify(value) })
    },

    delete(key) {
      const result = stmtDelete.run({ key })
      return result.changes > 0
    },

    keys(prefix?) {
      if (prefix) {
        const rows = stmtKeysByPrefix.all({ prefix }) as { key: string }[]
        return rows.map(r => r.key)
      }
      const rows = stmtAllKeys.all() as { key: string }[]
      return rows.map(r => r.key)
    },
  }
}
