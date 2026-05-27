import type { Database } from 'bun:sqlite'
import type { SearchHit, TranscriptEntryInput, TranscriptEntryRecord, TranscriptStore } from '../types'

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

    getBeforeSeq(conversationId, beforeSeq, limit) {
      // The `limit` highest-seq entries below beforeSeq, fetched DESC then
      // reversed to oldest-first (ready to prepend in the client).
      const rows = (
        db
          .prepare(
            'SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq < $beforeSeq ORDER BY seq DESC LIMIT $limit',
          )
          .all({ conversationId: conversationId, beforeSeq, limit }) as Params[]
      ).reverse()
      const entries = rows.map(rowToEntry)
      const oldestSeq = entries.length > 0 ? entries[0].seq : 0
      // More history exists iff any entry is strictly older than the oldest one
      // we just returned.
      const hasMore =
        oldestSeq > 0 &&
        !!db
          .prepare(
            'SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND seq < $oldestSeq LIMIT 1',
          )
          .get({ conversationId: conversationId, oldestSeq })
      return { entries, oldestSeq, hasMore }
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

    search(query, opts) {
      const trimmed = query.trim()
      if (!trimmed) return []
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100)
      const offset = Math.max(opts?.offset ?? 0, 0)

      // FTS5 MATCH expression. Caller can use FTS5 syntax (AND/OR/NOT, "phrases", prefix*).
      // sanitizeFtsQuery quotes individual tokens that contain characters FTS5 would
      // misparse (hyphens become NOT, colons become column refs, etc.) while leaving
      // operators, phrases, and parens alone. If everything still fails, fall back
      // to a single quoted literal phrase so casual queries don't error.
      const ftsQuery = sanitizeFtsQuery(trimmed)

      let sql = `
        SELECT t.*, bm25(transcript_fts) AS rank,
          snippet(transcript_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet
        FROM transcript_fts
        JOIN transcript_entries t ON t.id = transcript_fts.rowid
        WHERE transcript_fts MATCH $q
      `
      const params: Params = { q: ftsQuery, limit, offset }
      if (opts?.conversationId) {
        sql += ' AND t.conversation_id = $conversationId'
        params.conversationId = opts.conversationId
      }
      if (opts?.conversationIds?.length) {
        const placeholders = opts.conversationIds.map((_, i) => `$cid${i}`)
        sql += ` AND t.conversation_id IN (${placeholders.join(', ')})`
        for (let i = 0; i < opts.conversationIds.length; i++) {
          params[`cid${i}`] = opts.conversationIds[i]
        }
      }
      if (opts?.types?.length) {
        const placeholders = opts.types.map((_, i) => `$type${i}`)
        sql += ` AND t.type IN (${placeholders.join(', ')})`
        for (let i = 0; i < opts.types.length; i++) {
          params[`type${i}`] = opts.types[i]
        }
      }
      sql += ' ORDER BY rank LIMIT $limit OFFSET $offset'

      let rows: Params[]
      try {
        rows = db.prepare(sql).all(params) as Params[]
      } catch (err) {
        // FTS5 parse failure -- retry as a single literal phrase. SQLite surfaces
        // these as several error shapes: "fts5: syntax error", "no such column: X"
        // (when a bareword looks like a column ref), "unknown special query: ...",
        // etc. We catch all of them and degrade to a phrase search.
        const msg = err instanceof Error ? err.message : ''
        const literalPhrase = `"${trimmed.replace(/"/g, '""')}"`
        if (
          /syntax error|fts5|no such column|unknown special query|malformed match/i.test(msg) &&
          ftsQuery !== literalPhrase
        ) {
          params.q = literalPhrase
          rows = db.prepare(sql).all(params) as Params[]
        } else {
          throw err
        }
      }

      return rows.map(row => {
        const entry = rowToEntry(row)
        const hit: SearchHit = {
          id: entry.id,
          conversationId: entry.conversationId,
          seq: entry.seq,
          type: entry.type,
          subtype: entry.subtype,
          content: entry.content,
          timestamp: entry.timestamp,
          rank: row.rank as number,
          snippet: (row.snippet as string) ?? '',
        }
        return hit
      })
    },

    getWindow(conversationId, opts) {
      const before = Math.min(Math.max(opts.before ?? 5, 0), 50)
      const after = Math.min(Math.max(opts.after ?? 5, 0), 50)

      let centerSeq: number | null = null
      if (opts.aroundSeq != null) {
        centerSeq = opts.aroundSeq
      } else if (opts.aroundId != null) {
        const row = db
          .prepare('SELECT seq FROM transcript_entries WHERE id = $id AND conversation_id = $conversationId')
          .get({ id: opts.aroundId, conversationId }) as { seq: number } | null
        if (!row) return []
        centerSeq = row.seq
      }
      if (centerSeq == null) return []

      const minSeq = centerSeq - before
      const maxSeq = centerSeq + after
      const rows = db
        .prepare(
          'SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq >= $minSeq AND seq <= $maxSeq ORDER BY seq ASC',
        )
        .all({ conversationId, minSeq, maxSeq }) as Params[]
      return rows.map(rowToEntry)
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

    deleteForConversation(conversationId) {
      // Count BEFORE deleting: the transcript_fts_ad AFTER DELETE trigger keeps
      // the FTS index in sync (so the row delete also clears search docs), but
      // its shadow-table writes inflate run().changes -- making it useless as a
      // deleted-row count. Read the true count from the prepared counter first.
      const removed = (stmtCount.get({ conversationId: conversationId }) as { cnt: number }).cnt
      db.prepare('DELETE FROM transcript_entries WHERE conversation_id = $conversationId').run({
        conversationId: conversationId,
      })
      return removed
    },

    getIndexStats() {
      const totalEntries = (db.prepare('SELECT COUNT(*) AS c FROM transcript_entries').get() as { c: number }).c
      const indexedDocs = (db.prepare('SELECT COUNT(*) AS c FROM transcript_fts_docsize').get() as { c: number }).c
      const conversations = (
        db.prepare('SELECT COUNT(DISTINCT conversation_id) AS c FROM transcript_entries').get() as { c: number }
      ).c
      return {
        totalEntries,
        indexedDocs,
        conversations,
        isComplete: indexedDocs >= totalEntries,
      }
    },

    rebuildIndex() {
      const start = Date.now()
      // 'rebuild' is the canonical FTS5 way to repopulate an external-content
      // table from the source rows. Wraps the read+write in a single tx for
      // atomicity -- partial rebuilds leave the index in a queryable state.
      const tx = db.transaction(() => {
        db.run("INSERT INTO transcript_fts(transcript_fts) VALUES('delete-all')")
        db.run("INSERT INTO transcript_fts(transcript_fts) VALUES('rebuild')")
      })
      tx()
      const docsIndexed = (db.prepare('SELECT COUNT(*) AS c FROM transcript_fts_docsize').get() as { c: number }).c
      return { docsIndexed, durationMs: Date.now() - start }
    },
  }
}

// Token-level FTS5 sanitizer. Walks the query, leaves operators (AND/OR/NOT/
// NEAR), already-quoted phrases, parens, and column refs alone, and wraps any
// remaining token in double quotes if it contains characters FTS5 would
// misparse -- most notably hyphens (parsed as NOT), apostrophes, and dots.
// Bareword tokens and the trailing `*` prefix-match marker pass through.
//
// Example: `universe OR war-council OR foo*` -> `universe OR "war-council" OR foo*`
function sanitizeFtsQuery(query: string): string {
  const out: string[] = []
  let i = 0
  while (i < query.length) {
    const ch = query[i] as string
    if (/[\s()]/.test(ch)) {
      out.push(ch)
      i++
      continue
    }
    if (ch === '"') {
      const end = query.indexOf('"', i + 1)
      if (end === -1) {
        out.push(`${query.slice(i)}"`)
        break
      }
      out.push(query.slice(i, end + 1))
      i = end + 1
      continue
    }
    let j = i
    while (j < query.length && !/[\s()"]/.test(query[j] as string)) j++
    out.push(quoteFtsToken(query.slice(i, j)))
    i = j
  }
  return out.join('')
}

const FTS_OPERATORS = /^(AND|OR|NOT|NEAR)$/
const FTS_COLUMN_REF = /^[a-zA-Z_][a-zA-Z0-9_]*:[^\s]+$/
const FTS_BAREWORD = /^[a-zA-Z0-9_]+$/

function quoteFtsToken(token: string): string {
  if (FTS_OPERATORS.test(token) || FTS_COLUMN_REF.test(token)) return token
  const hasWildcard = token.endsWith('*')
  const core = hasWildcard ? token.slice(0, -1) : token
  if (FTS_BAREWORD.test(core)) return token
  return `"${core.replace(/"/g, '""')}"${hasWildcard ? '*' : ''}`
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
