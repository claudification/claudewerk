import type { Database } from 'bun:sqlite'
import type { EventInput, EventRecord, EventStore } from '../types'
import { appendTypeFilter } from './sql-filters'

type Params = Record<string, string | number | bigint | boolean | null>

function rowToEvent(row: Params): EventRecord {
  return {
    id: row.id as number,
    conversationId: row.conversation_id as string,
    type: row.type as string,
    data: row.data ? JSON.parse(row.data as string) : undefined,
    createdAt: row.created_at as number,
  }
}

export function createSqliteEventStore(db: Database): EventStore {
  const stmtInsert = db.prepare(`
    INSERT INTO events (conversation_id, type, data, created_at)
    VALUES ($conversationId, $type, $data, $createdAt)
  `)

  return {
    append(conversationId, event: EventInput) {
      stmtInsert.run({
        conversationId: conversationId,
        type: event.type,
        data: event.data ? JSON.stringify(event.data) : null,
        createdAt: Date.now(),
      })
    },

    getForConversation(conversationId, opts) {
      let sql = 'SELECT * FROM events WHERE conversation_id = $conversationId'
      const params: Params = { conversationId: conversationId }

      sql = appendTypeFilter(sql, params, opts?.types)

      if (opts?.afterId != null) {
        sql += ' AND id > $afterId'
        params.afterId = opts.afterId
      }

      sql += ' ORDER BY id ASC'

      if (opts?.limit) {
        const allRows = db.prepare(sql).all(params) as Params[]
        return allRows.slice(-opts.limit).map(rowToEvent)
      }

      const rows = db.prepare(sql).all(params) as Params[]
      return rows.map(rowToEvent)
    },

    pruneOlderThan(cutoffMs) {
      const result = db.prepare('DELETE FROM events WHERE created_at < $cutoff').run({ cutoff: cutoffMs })
      return result.changes
    },

    deleteForConversation(conversationId) {
      const result = db
        .prepare('DELETE FROM events WHERE conversation_id = $conversationId')
        .run({ conversationId: conversationId })
      return result.changes
    },
  }
}
