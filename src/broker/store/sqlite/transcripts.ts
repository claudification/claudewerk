import type { Database, Statement } from 'bun:sqlite'
import type {
  SearchHit,
  TranscriptAppendResult,
  TranscriptEntryInput,
  TranscriptEntryRecord,
  TranscriptStore,
} from '../types'

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

// ---------- getPage / getLatest hoisted statement sets ----------
// 3 agent-scope variants × 2 directions × 2 cursor presence = 12 page SELECT stmts.
// 3 agent-scope variants × 1 = 3 getLatest stmts.
// Encoded as [agentVariant][direction][hasCursor]: 0=all, 1=noAgent, 2=agent

const BASE = 'SELECT * FROM transcript_entries WHERE conversation_id = $conversationId'

/**
 * RENDER ORDER IS `(timestamp, seq)`, NOT `seq`.
 *
 * `seq` is an ARRIVAL counter (`MAX(seq)+1` per scope, in the order batches
 * reach the broker). Arrival and chronology diverge whenever an entry reaches
 * the broker late, which in headless is routine, not exceptional: anything the
 * stdout pipe never carries -- `system/stop_hook_summary`, `api_error`, and any
 * entry stdout dropped during a socket blip -- arrives only via a file resend,
 * minutes to hours after the fact. It keeps its ORIGINAL timestamp and takes a
 * BRAND NEW high seq, so ordering by seq pinned a 20:23 entry below a 20:42 one
 * forever. Measured: 82 of 82 `stop_hook_summary` rows in one day, average 28
 * minutes late, and 1318 seq/timestamp inversions in that day against 1/day
 * before. `seq` remains the dedup and delta cursor; it just stops pretending to
 * be the clock.
 */
const CHRONO_ASC = 'ORDER BY timestamp ASC, seq ASC'
const CHRONO_DESC = 'ORDER BY timestamp DESC, seq DESC'
const PAGE_SQLS: string[][][] = [[], [], []] // [agentVariant][dir][hasCursor]

for (const [av, agentFrag] of [
  [0, ''],
  [1, ' AND agent_id IS NULL'],
  [2, ' AND agent_id = $agentId'],
] as [number, string][]) {
  PAGE_SQLS[av] = [[], []]
  for (const [di, dir] of [
    [0, 'ASC'],
    [1, 'DESC'],
  ] as [number, string][]) {
    const base = `${BASE}${agentFrag}`
    // no cursor
    PAGE_SQLS[av][di][0] = `${base} ORDER BY id ${dir} LIMIT $limit`
    // with cursor (forward = id > $cursor, backward = id < $cursor)
    const cmp = di === 0 ? '>' : '<'
    PAGE_SQLS[av][di][1] = `${base} AND id ${cmp} $cursor ORDER BY id ${dir} LIMIT $limit`
  }
}

// "The last N entries" means the chronologically last N, not the last N
// INGESTED -- a gap-fill recovered from the file is newly ingested but old.
const LATEST_SQLS = [
  `${BASE} ${CHRONO_DESC} LIMIT $limit`,
  `${BASE} AND agent_id IS NULL ${CHRONO_DESC} LIMIT $limit`,
  `${BASE} AND agent_id = $agentId ${CHRONO_DESC} LIMIT $limit`,
]

// Cursor-navigation stmts (getNextId / getPrevId):
// 3 agent variants × 2 directions = 6
const NAV_SQLS: string[][] = [[], [], []]
for (const [av, agentFrag] of [
  [0, ''],
  [1, ' AND agent_id IS NULL'],
  [2, ' AND agent_id = $agentId'],
] as [number, string][]) {
  NAV_SQLS[av][0] =
    `SELECT id FROM transcript_entries WHERE conversation_id = $conversationId AND id > $refId${agentFrag} ORDER BY id ASC LIMIT 1`
  NAV_SQLS[av][1] =
    `SELECT id FROM transcript_entries WHERE conversation_id = $conversationId AND id < $refId${agentFrag} ORDER BY id DESC LIMIT 1`
}

// getSinceSeq stmts per agent-scope variant: maxSeq + gapCheck + mainSelect (no-limit) + mainSelect (limit)
// getBeforeSeq stmts: mainSelect + hasMoreCheck
// getWindow: aroundId seq lookup + window select
// These are fewer and less combinatorial so we prepare them inline per-call via a small
// factory-level Statement cache to avoid the per-call re-parse cost (B-H3 intent).

export function createSqliteTranscriptStore(db: Database): TranscriptStore {
  const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO transcript_entries
      (conversation_id, seq, sync_epoch, type, subtype, agent_id, uuid, content, timestamp, ingested_at)
    VALUES ($conversationId, $seq, $syncEpoch, $type, $subtype, $agentId, $uuid, $content, $timestamp, $ingestedAt)
  `)

  const stmtMaxSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) as max_seq FROM transcript_entries WHERE conversation_id = $conversationId',
  )
  // Per-scope max seq -- the basis for independent monotonic seq per
  // (conversation_id, agent_id). Parent rows (agent_id IS NULL) and each agent's
  // sub-stream advance separately.
  const stmtMaxSeqAgent = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) as max_seq FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id = $agentId',
  )
  const stmtMaxSeqNoAgent = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) as max_seq FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id IS NULL',
  )

  // Seq-by-uuid probe -- served straight off the UNIQUE(conversation_id, uuid)
  // index, so it stays O(log n) on the append hot path. Doubles as the
  // existence check behind `hasUuid`.
  const stmtSeqByUuid = db.prepare(
    'SELECT seq FROM transcript_entries WHERE conversation_id = $conversationId AND uuid = $uuid LIMIT 1',
  )

  const stmtCount = db.prepare('SELECT COUNT(*) as cnt FROM transcript_entries WHERE conversation_id = $conversationId')
  const stmtCountAgent = db.prepare(
    'SELECT COUNT(*) as cnt FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id = $agentId',
  )
  const stmtCountNoAgent = db.prepare(
    'SELECT COUNT(*) as cnt FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id IS NULL',
  )

  // Hoist the combinatorial page/nav/latest statement sets (B-H3).
  // Indexed by [agentVariant][dir][hasCursor] or [agentVariant][dir].
  const pageStmts: Statement[][] = [
    [
      db.prepare(PAGE_SQLS[0][0][0]),
      db.prepare(PAGE_SQLS[0][0][1]),
      db.prepare(PAGE_SQLS[0][1][0]),
      db.prepare(PAGE_SQLS[0][1][1]),
    ],
    [
      db.prepare(PAGE_SQLS[1][0][0]),
      db.prepare(PAGE_SQLS[1][0][1]),
      db.prepare(PAGE_SQLS[1][1][0]),
      db.prepare(PAGE_SQLS[1][1][1]),
    ],
    [
      db.prepare(PAGE_SQLS[2][0][0]),
      db.prepare(PAGE_SQLS[2][0][1]),
      db.prepare(PAGE_SQLS[2][1][0]),
      db.prepare(PAGE_SQLS[2][1][1]),
    ],
  ]
  // pageStmts[av] = [fwdNoCursor, fwdCursor, bwdNoCursor, bwdCursor]

  const latestStmts = [db.prepare(LATEST_SQLS[0]), db.prepare(LATEST_SQLS[1]), db.prepare(LATEST_SQLS[2])]

  const navStmts: Statement[][] = [
    [db.prepare(NAV_SQLS[0][0]), db.prepare(NAV_SQLS[0][1])],
    [db.prepare(NAV_SQLS[1][0]), db.prepare(NAV_SQLS[1][1])],
    [db.prepare(NAV_SQLS[2][0]), db.prepare(NAV_SQLS[2][1])],
  ]
  // navStmts[av][0] = next (after), navStmts[av][1] = prev (before)

  // getSinceSeq / getBeforeSeq: 3 agent variants × a few SQL shapes each.
  // Hoisted as flat arrays indexed by agentVariant (0=all, 1=noAgent, 2=agent).
  const sinceMaxSeqStmts = [
    db.prepare(
      'SELECT COALESCE(MAX(seq), 0) as max_seq FROM transcript_entries WHERE conversation_id = $conversationId',
    ),
    db.prepare(
      'SELECT COALESCE(MAX(seq), 0) as max_seq FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id IS NULL',
    ),
    db.prepare(
      'SELECT COALESCE(MAX(seq), 0) as max_seq FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id = $agentId',
    ),
  ]
  const sinceGapCheckStmts = [
    db.prepare('SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND seq = $sinceSeq'),
    db.prepare(
      'SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND seq = $sinceSeq AND agent_id IS NULL',
    ),
    db.prepare(
      'SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND seq = $sinceSeq AND agent_id = $agentId',
    ),
  ]
  // main select: with limit and without -- [av][hasLimit]
  const sinceSelectStmts: Statement[][] = [
    [
      db.prepare(
        `SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq > $sinceSeq ${CHRONO_ASC}`,
      ),
      db.prepare(
        `SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq > $sinceSeq ${CHRONO_ASC} LIMIT $limit`,
      ),
    ],
    [
      db.prepare(
        `SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq > $sinceSeq AND agent_id IS NULL ${CHRONO_ASC}`,
      ),
      db.prepare(
        `SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq > $sinceSeq AND agent_id IS NULL ${CHRONO_ASC} LIMIT $limit`,
      ),
    ],
    [
      db.prepare(
        `SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq > $sinceSeq AND agent_id = $agentId ${CHRONO_ASC}`,
      ),
      db.prepare(
        `SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq > $sinceSeq AND agent_id = $agentId ${CHRONO_ASC} LIMIT $limit`,
      ),
    ],
  ]

  // Backward pagination is CHRONOLOGICAL, matching the render order: "older
  // than the cursor" means it sorts before `(cursorTs, cursorSeq)`, not that it
  // has a smaller seq. Spelled out rather than using a row-value comparison so
  // the planner can still use the (conversation_id, timestamp, seq) index.
  // The caller keeps passing a plain seq -- the cursor's timestamp is looked up
  // here, so the wire API and the client are unchanged.
  const olderThanCursor = '(timestamp < $beforeTs OR (timestamp = $beforeTs AND seq < $beforeSeq))'
  const beforeSelectStmts = [
    db.prepare(`${BASE} AND ${olderThanCursor} ${CHRONO_DESC} LIMIT $limit`),
    db.prepare(`${BASE} AND agent_id IS NULL AND ${olderThanCursor} ${CHRONO_DESC} LIMIT $limit`),
    db.prepare(`${BASE} AND agent_id = $agentId AND ${olderThanCursor} ${CHRONO_DESC} LIMIT $limit`),
  ]
  const beforeHasMoreStmts = [
    db.prepare(
      `SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND ${olderThanCursor} LIMIT 1`,
    ),
    db.prepare(
      `SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id IS NULL AND ${olderThanCursor} LIMIT 1`,
    ),
    db.prepare(
      `SELECT 1 FROM transcript_entries WHERE conversation_id = $conversationId AND agent_id = $agentId AND ${olderThanCursor} LIMIT 1`,
    ),
  ]
  // Resolve a seq cursor to its row's timestamp, per scope.
  const beforeCursorTsStmts = [
    db.prepare(
      'SELECT timestamp FROM transcript_entries WHERE conversation_id = $conversationId AND seq = $seq LIMIT 1',
    ),
    db.prepare(
      'SELECT timestamp FROM transcript_entries WHERE conversation_id = $conversationId AND seq = $seq AND agent_id IS NULL LIMIT 1',
    ),
    db.prepare(
      'SELECT timestamp FROM transcript_entries WHERE conversation_id = $conversationId AND seq = $seq AND agent_id = $agentId LIMIT 1',
    ),
  ]
  // Fallback for a cursor seq no row carries -- seq space has holes (a batch
  // that lost its rows to the scope guard, or a client cursor minted by the
  // no-store path). The nearest LOWER seq is the closest real position to page
  // from; scrollback degrades by a row or two instead of dead-ending.
  const beforeCursorNearestStmts = [
    db.prepare(
      'SELECT timestamp, seq FROM transcript_entries WHERE conversation_id = $conversationId AND seq < $seq ORDER BY seq DESC LIMIT 1',
    ),
    db.prepare(
      'SELECT timestamp, seq FROM transcript_entries WHERE conversation_id = $conversationId AND seq < $seq AND agent_id IS NULL ORDER BY seq DESC LIMIT 1',
    ),
    db.prepare(
      'SELECT timestamp, seq FROM transcript_entries WHERE conversation_id = $conversationId AND seq < $seq AND agent_id = $agentId ORDER BY seq DESC LIMIT 1',
    ),
  ]

  // getWindow helpers
  const stmtWindowSeqById = db.prepare(
    'SELECT seq FROM transcript_entries WHERE id = $id AND conversation_id = $conversationId',
  )
  const stmtWindowSelect = db.prepare(
    `SELECT * FROM transcript_entries WHERE conversation_id = $conversationId AND seq >= $minSeq AND seq <= $maxSeq ${CHRONO_ASC}`,
  )

  // Misc single-use hoisted stmts
  const stmtDeleteForConv = db.prepare('DELETE FROM transcript_entries WHERE conversation_id = $conversationId')
  const stmtPruneOlderThan = db.prepare('DELETE FROM transcript_entries WHERE timestamp < $cutoff')
  const stmtIndexTotalEntries = db.prepare('SELECT COUNT(*) AS c FROM transcript_entries')
  const stmtIndexDocs = db.prepare('SELECT COUNT(*) AS c FROM transcript_fts_docsize')
  const stmtIndexConversations = db.prepare('SELECT COUNT(DISTINCT conversation_id) AS c FROM transcript_entries')

  /** Resolve [agentVariant, agentParam] from agentId filter */
  function agentVariant(agentId: string | null | undefined): [number, Params] {
    if (agentId === undefined) return [0, {}]
    if (agentId === null) return [1, {}]
    return [2, { agentId }]
  }

  function getNextId(conversationId: string, afterId: number, agentId: string | null | undefined): number | null {
    const [av, agentParams] = agentVariant(agentId)
    const row = navStmts[av][0].get({ conversationId, refId: afterId, ...agentParams }) as { id: number } | null
    return row?.id ?? null
  }

  function getPrevId(conversationId: string, beforeId: number, agentId: string | null | undefined): number | null {
    const [av, agentParams] = agentVariant(agentId)
    const row = navStmts[av][1].get({ conversationId, refId: beforeId, ...agentParams }) as { id: number } | null
    return row?.id ?? null
  }

  /** Highest seq currently stored in one scope of a conversation. The base a
   *  batch counts up from. */
  function scopeBaseSeq(conversationId: string, agentId: string | null): number {
    const row =
      agentId === null
        ? stmtMaxSeqNoAgent.get({ conversationId: conversationId })
        : stmtMaxSeqAgent.get({ conversationId: conversationId, agentId })
    return (row as { max_seq: number }).max_seq
  }

  /**
   * Insert one entry and report the seq it ended up with.
   *
   * `seqByScope` is the batch's running per-scope counter, seeded lazily from
   * the stored max so a batch mixing parent + agent entries keeps each scope
   * independent and monotonic. An ignored duplicate leaves that counter exactly
   * where it was, so the number is NOT burned -- consuming it is what turned one
   * conversation's 9,782 rows into a 37,339-wide seq space, and the REST delta
   * gap check misfires on holes that wide.
   */
  function appendOne(
    conversationId: string,
    syncEpoch: string,
    e: TranscriptEntryInput,
    seqByScope: Map<string, number>,
    ingestedAt: number,
  ): TranscriptAppendResult {
    const agentId = e.agentId ?? null
    const scopeKey = agentId ?? ' parent'
    const base = seqByScope.get(scopeKey) ?? scopeBaseSeq(conversationId, agentId)
    const candidate = base + 1
    const { changes } = stmtInsert.run({
      conversationId: conversationId,
      seq: candidate,
      syncEpoch,
      type: e.type,
      subtype: e.subtype ?? null,
      agentId,
      uuid: e.uuid,
      content: JSON.stringify(e.content),
      timestamp: e.timestamp,
      ingestedAt,
    })
    if (changes > 0) {
      seqByScope.set(scopeKey, candidate)
      return { uuid: e.uuid, seq: candidate, inserted: true }
    }
    // Already stored (replay / full-file re-read) -- report the existing row's seq.
    seqByScope.set(scopeKey, base)
    const existing = stmtSeqByUuid.get({ conversationId, uuid: e.uuid }) as { seq: number } | null
    return { uuid: e.uuid, seq: existing?.seq ?? candidate, inserted: false }
  }

  /** The chronological cursor a `before=<seq>` request means: the named row's
   *  `(timestamp, seq)`, or -- when that seq names a hole -- the nearest lower
   *  seq, widened by one so that row is itself included. `null` when the
   *  conversation holds nothing older. */
  function resolveBeforeCursor(
    av: number,
    conversationId: string,
    seq: number,
    agentParams: Params,
  ): { beforeTs: number; beforeSeq: number } | null {
    const exact = beforeCursorTsStmts[av].get({ conversationId, seq, ...agentParams }) as { timestamp: number } | null
    if (exact) return { beforeTs: exact.timestamp, beforeSeq: seq }
    const nearest = beforeCursorNearestStmts[av].get({ conversationId, seq, ...agentParams }) as {
      timestamp: number
      seq: number
    } | null
    return nearest ? { beforeTs: nearest.timestamp, beforeSeq: nearest.seq + 1 } : null
  }

  return {
    append(conversationId, syncEpoch, entries: TranscriptEntryInput[]): TranscriptAppendResult[] {
      const results: TranscriptAppendResult[] = []
      const seqByScope = new Map<string, number>()
      const now = Date.now()
      const doAppend = db.transaction(() => {
        for (const e of entries) {
          results.push(appendOne(conversationId, syncEpoch, e, seqByScope, now))
        }
      })
      doAppend()
      return results
    },

    getPage(conversationId, opts) {
      const limit = opts.limit ?? 50
      const backward = (opts.direction ?? 'forward') === 'backward'
      const di = backward ? 1 : 0

      const [av, agentParams] = agentVariant(opts.agentId)

      // Use the already-hoisted count stmts (no re-parse) (B-H3).
      let totalCount: number
      if (av === 0) {
        totalCount = (stmtCount.get({ conversationId }) as { cnt: number }).cnt
      } else if (av === 1) {
        totalCount = (stmtCountNoAgent.get({ conversationId }) as { cnt: number }).cnt
      } else {
        totalCount = (stmtCountAgent.get({ conversationId, agentId: opts.agentId as string }) as { cnt: number }).cnt
      }

      const hasCursor = opts.cursor != null ? 1 : 0
      const stmt = pageStmts[av][di * 2 + hasCursor]
      const params: Params = { conversationId, limit, ...agentParams }
      if (hasCursor) params.cursor = opts.cursor as number

      let rows = stmt.all(params) as Params[]
      if (backward) rows = rows.reverse()
      const entries = rows.map(rowToEntry)

      const nextCursor =
        entries.length > 0 ? getNextId(conversationId, entries[entries.length - 1].id, opts.agentId) : null
      const prevCursor = entries.length > 0 ? getPrevId(conversationId, entries[0].id, opts.agentId) : null

      return { entries, nextCursor, prevCursor, totalCount }
    },

    getLatest(conversationId, limit, agentId) {
      const [av, agentParams] = agentVariant(agentId)
      const rows = (latestStmts[av].all({ conversationId, limit, ...agentParams }) as Params[]).reverse()
      return rows.map(rowToEntry)
    },

    getSinceSeq(conversationId, sinceSeq, limit, agentId) {
      const [av, agentParams] = agentVariant(agentId)
      const maxSeq = (sinceMaxSeqStmts[av].get({ conversationId, ...agentParams }) as { max_seq: number }).max_seq

      let gap = false
      if (sinceSeq > 0) {
        const check = sinceGapCheckStmts[av].get({ conversationId, sinceSeq, ...agentParams })
        gap = !check
      }

      const hasLimit = limit ? 1 : 0
      const params: Params = { conversationId, sinceSeq, ...agentParams }
      if (limit) params.limit = limit
      const rows = sinceSelectStmts[av][hasLimit].all(params) as Params[]
      const entries = rows.map(rowToEntry)
      const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : maxSeq

      return { entries, lastSeq, gap }
    },

    getBeforeSeq(conversationId, beforeSeq, limit, agentId) {
      const [av, agentParams] = agentVariant(agentId)
      // The cursor is a seq on the wire but chronological in meaning, so resolve
      // it to its row's timestamp first, falling back to the nearest lower seq
      // when the cursor names a hole.
      const cursor = resolveBeforeCursor(av, conversationId, beforeSeq, agentParams)
      if (!cursor) return { entries: [], oldestSeq: 0, hasMore: false }
      // The `limit` chronologically newest entries below the cursor, fetched
      // DESC then reversed to oldest-first (ready to prepend in the client).
      const rows = (
        beforeSelectStmts[av].all({ conversationId, ...cursor, limit, ...agentParams }) as Params[]
      ).reverse()
      const entries = rows.map(rowToEntry)
      const oldest = entries[0]
      // More history exists iff anything sorts strictly before the oldest entry
      // we just returned.
      const hasMore =
        !!oldest &&
        !!beforeHasMoreStmts[av].get({
          conversationId,
          beforeTs: oldest.timestamp,
          beforeSeq: oldest.seq,
          ...agentParams,
        })
      return { entries, oldestSeq: oldest?.seq ?? 0, hasMore }
    },

    getLastSeq(conversationId) {
      return (stmtMaxSeq.get({ conversationId: conversationId }) as { max_seq: number }).max_seq
    },

    hasUuid(conversationId, uuid) {
      return stmtSeqByUuid.get({ conversationId, uuid }) != null
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
      // Ordering: bm25 relevance by default; `recency` sorts newest-first by the
      // entry timestamp (indexed), with id as a stable tiebreaker for same-ms rows.
      sql += opts?.sort === 'recency' ? ' ORDER BY t.timestamp DESC, t.id DESC' : ' ORDER BY rank'
      sql += ' LIMIT $limit OFFSET $offset'

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
        const row = stmtWindowSeqById.get({ id: opts.aroundId, conversationId }) as { seq: number } | null
        if (!row) return []
        centerSeq = row.seq
      }
      if (centerSeq == null) return []

      const minSeq = centerSeq - before
      const maxSeq = centerSeq + after
      const rows = stmtWindowSelect.all({ conversationId, minSeq, maxSeq }) as Params[]
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
      const result = stmtPruneOlderThan.run({ cutoff: cutoffMs })
      return result.changes
    },

    deleteForConversation(conversationId) {
      // Count BEFORE deleting: the transcript_fts_ad AFTER DELETE trigger keeps
      // the FTS index in sync (so the row delete also clears search docs), but
      // its shadow-table writes inflate run().changes -- making it useless as a
      // deleted-row count. Read the true count from the prepared counter first.
      const removed = (stmtCount.get({ conversationId: conversationId }) as { cnt: number }).cnt
      stmtDeleteForConv.run({ conversationId: conversationId })
      return removed
    },

    getIndexStats() {
      const totalEntries = (stmtIndexTotalEntries.get() as { c: number }).c
      const indexedDocs = (stmtIndexDocs.get() as { c: number }).c
      const conversations = (stmtIndexConversations.get() as { c: number }).c
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
      const docsIndexed = (stmtIndexDocs.get() as { c: number }).c
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
