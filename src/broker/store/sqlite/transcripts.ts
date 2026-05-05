import type { Database } from 'bun:sqlite'
import type { TranscriptEntryInput, TranscriptEntryRecord, TranscriptStore } from '../types'

type Params = Record<string, string | number | bigint | boolean | null>

function rowToEntry(row: Params): TranscriptEntryRecord {
  return {
    id: row.id as number,
    conversationId: row.conversation_id as string,
    seq: row.seq as number,
    syncEpoch: row.sync_epoch as string,
    type: row.type as string,
    subtype: (row.subtype as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    uuid: row.uuid as string,
    content: JSON.parse(row.content as string),
    timestamp: row.timestamp as number,
    ingestedAt: row.ingested_at as number,
  }
}

export function createSqliteTranscriptStore(db: Database): TranscriptStore {
  const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO transcript_entries
      (conversation_id, seq, sync_epoch, type, subtype, agent_id, uuid, content, timestamp, ingested_at)
    VALUES ($conversationId, $seq, $syncEpoch, $type, $subtype, $agentId, $uuid, $content, $timestamp, $ingestedAt)
  `)

  const stmtMaxSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) as max_seq FROM transcript_entries WHERE conversation_id = $conversationId',
  )

  const stmtCount = db.prepare('SELECT COUNT(*) as cnt FROM transcript_entries WHERE conversation_id = $conversationId')
  const stmtCountAgent = db.prepare(
    'SELECT COUNT(*) as cnt FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id = $agentId',
  )
  const stmtCountNoAgent = db.prepare(
    'SELECT COUNT(*) as cnt FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id IS NULL',
  )

  return {
    append(conversationId, syncEpoch, entries: TranscriptEntryInput[]) {
      const doAppend = db.transaction(() => {
        let seq = (stmtMaxSeq.get({ conversationId: conversationId }) as { max_seq: number }).max_seq
        const now = Date.now()
        for (const e of entries) {
          seq++
          stmtInsert.run({
            conversationId: conversationId,
            seq: seq,
            syncEpoch,
            type: e.type,
            subtype: e.subtype ?? null,
            agentId: e.agentId ?? null,
            uuid: e.uuid,
            content: JSON.stringify(e.content),
            timestamp: e.timestamp,
            ingestedAt: now,
          })
        }
      })
      doAppend()
    },

    getPage(conversationId, opts) {
      const limit = opts.limit ?? 50
      const direction = opts.direction ?? 'forward'

      let totalSql = 'SELECT COUNT(*) as cnt FROM transcript_entries WHERE conversation_id = $conversationId'
      const totalParams: Params = { conversationId: conversationId }
      if (opts.agentId !== undefined) {
        if (opts.agentId === null) {
          totalSql += ' AND agent_id IS NULL'
        } else {
          totalSql += ' AND agent_id = $agentId'
          totalParams.agentId = opts.agentId
        }
      }
      const totalCount = (db.prepare(totalSql).get(totalParams) as { cnt: number }).cnt

      let sql = 'SELECT * FROM transcript_entries WHERE conversation_id = $conversationId'
      const params: Params = { conversationId: conversationId, limit }

      if (opts.agentId !== undefined) {
        if (opts.agentId === null) {
          sql += ' AND agent_id IS NULL'
        } else {
          sql += ' AND agent_id = $agentId'
          params.agentId = opts.agentId
        }
      }

      if (opts.cursor != null) {
        if (direction === 'forward') {
          sql += ' AND id > $cursor'
          params.cursor = opts.cursor
        } else {
          sql += ' AND id < $cursor'
          params.cursor = opts.cursor
        }
      }

      if (direction === 'backward') {
        sql += ' ORDER BY id DESC LIMIT $limit'
        const rows = (db.prepare(sql).all(params) as Params[]).reverse()
        const entries = rows.map(rowToEntry)

        const nextCursor =
          entries.length > 0 ? getNextId(db, conversationId, entries[entries.length - 1].id, opts.agentId) : null
        const prevCursor = entries.length > 0 ? getPrevId(db, conversationId, entries[0].id, opts.agentId) : null

        return { entries, nextCursor, prevCursor, totalCount }
      }

      sql += ' ORDER BY id ASC LIMIT $limit'
      const rows = db.prepare(sql).all(params) as Params[]
      const entries = rows.map(rowToEntry)

      const nextCursor =
        entries.length > 0 ? getNextId(db, conversationId, entries[entries.length - 1].id, opts.agentId) : null
      const prevCursor = entries.length > 0 ? getPrevId(db, conversationId, entries[0].id, opts.agentId) : null

      return { entries, nextCursor, prevCursor, totalCount }
    },

    getLatest(conversationId, limit, agentId) {
      let sql = 'SELECT * FROM transcript_entries WHERE conversation_id = $conversationId'
      const params: Params = { conversationId: conversationId, limit }

      if (agentId !== undefined) {
        if (agentId === null) {
          sql += ' AND agent_id IS NULL'
        } else {
          sql += ' AND agent_id = $agentId'
          params.agentId = agentId
        }
      }

      sql += ' ORDER BY id DESC LIMIT $limit'
      const rows = (db.prepare(sql).all(params) as Params[]).reverse()
      return rows.map(rowToEntry)
    },

    getSinceSeq(conversationId, sinceSeq, limit) {
      const maxSeq = (stmtMaxSeq.get({ conversationId: conversationId }) as { max_seq: number }).max_seq

      let gap = false
      if (sinceSeq > 0) {
        const check = db
          .prepare('SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND seq = $sinceSeq')
          .get({ conversationId: conversationId, sinceSeq })
        gap = !check
      }

      let sql =
        'SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq > $sinceSeq ORDER BY seq ASC'
      const params: Params = { conversationId: conversationId, sinceSeq }
      if (limit) {
        sql += ' LIMIT $limit'
        params.limit = limit
      }

      const rows = db.prepare(sql).all(params) as Params[]
      const entries = rows.map(rowToEntry)
      const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : maxSeq

      return { entries, lastSeq, gap }
    },

    getLastSeq(conversationId) {
      return (stmtMaxSeq.get({ conversationId: conversationId }) as { max_seq: number }).max_seq
    },

    find(conversationId, filter) {
      let sql = 'SELECT * FROM transcript_entries WHERE conversation_id = $conversationId'
      const params: Params = { conversationId: conversationId }

      if (filter.types?.length) {
        const placeholders = filter.types.map((_, i) => `$type${i}`)
        sql += ` AND type IN (${placeholders.join(', ')})`
        for (let i = 0; i < filter.types.length; i++) {
          params[`type${i}`] = filter.types[i]
        }
      }

      if (filter.subtypes?.length) {
        const placeholders = filter.subtypes.map((_, i) => `$subtype${i}`)
        sql += ` AND subtype IN (${placeholders.join(', ')})`
        for (let i = 0; i < filter.subtypes.length; i++) {
          params[`subtype${i}`] = filter.subtypes[i]
        }
      }

      if (filter.agentId !== undefined) {
        if (filter.agentId === null) {
          sql += ' AND agent_id IS NULL'
        } else {
          sql += ' AND agent_id = $agentId'
          params.agentId = filter.agentId
        }
      }

      if (filter.after != null) {
        sql += ' AND timestamp > $after'
        params.after = filter.after
      }
      if (filter.before != null) {
        sql += ' AND timestamp < $before'
        params.before = filter.before
      }

      sql += ' ORDER BY id ASC'
      if (filter.limit) {
        sql += ' LIMIT $limit'
        params.limit = filter.limit
      }

      const rows = db.prepare(sql).all(params) as Params[]
      return rows.map(rowToEntry)
    },

    search(_query, _opts) {
      throw new Error('FTS not configured')
    },

    count(conversationId, agentId) {
      if (agentId !== undefined) {
        if (agentId === null) {
          return (stmtCountNoAgent.get({ conversationId: conversationId }) as { cnt: number }).cnt
        }
        return (stmtCountAgent.get({ conversationId: conversationId, agentId }) as { cnt: number }).cnt
      }
      return (stmtCount.get({ conversationId: conversationId }) as { cnt: number }).cnt
    },

    pruneOlderThan(cutoffMs) {
      const result = db.prepare('DELETE FROM transcript_entries WHERE timestamp < $cutoff').run({ cutoff: cutoffMs })
      return result.changes
    },
  }
}

function getNextId(
  db: Database,
  conversationId: string,
  afterId: number,
  agentId: string | null | undefined,
): number | null {
  let sql = 'SELECT id FROM transcript_entries WHERE conversation_id = $conversationId AND id > $afterId'
  const params: Params = { conversationId: conversationId, afterId }
  if (agentId !== undefined) {
    if (agentId === null) {
      sql += ' AND agent_id IS NULL'
    } else {
      sql += ' AND agent_id = $agentId'
      params.agentId = agentId
    }
  }
  sql += ' ORDER BY id ASC LIMIT 1'
  const row = db.prepare(sql).get(params) as { id: number } | null
  return row?.id ?? null
}

function getPrevId(
  db: Database,
  conversationId: string,
  beforeId: number,
  agentId: string | null | undefined,
): number | null {
  let sql = 'SELECT id FROM transcript_entries WHERE conversation_id = $conversationId AND id < $beforeId'
  const params: Params = { conversationId: conversationId, beforeId }
  if (agentId !== undefined) {
    if (agentId === null) {
      sql += ' AND agent_id IS NULL'
    } else {
      sql += ' AND agent_id = $agentId'
      params.agentId = agentId
    }
  }
  sql += ' ORDER BY id DESC LIMIT 1'
  const row = db.prepare(sql).get(params) as { id: number } | null
  return row?.id ?? null
}
