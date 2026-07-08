import type { Database } from 'bun:sqlite'
import { type PerMessageTokenSample, sampleFromMessageUsage } from '../../../shared/token-usage'
import type { TokenBucket, TokenBucketFilter, TokenSampleInput, TokenStore } from '../types'

type Binds = Record<string, string | number | null>

function queryAll(db: Database, sql: string, binds?: Binds): unknown[] {
  const stmt = db.query(sql)
  return binds ? stmt.all(binds as never) : stmt.all()
}

/** Parse a stored transcript_entries.content JSON blob into a token sample. */
function parseEntryUsage(content: string): PerMessageTokenSample | null {
  let entry: { message?: { usage?: Parameters<typeof sampleFromMessageUsage>[0]; model?: string } }
  try {
    entry = JSON.parse(content)
  } catch {
    return null
  }
  return sampleFromMessageUsage(entry.message?.usage, entry.message?.model, '')
}

/** Normalise profile to its bucket name. Empty / undefined -> 'default'. */
function profileBucket(p: string | null | undefined): string {
  return p && p.length > 0 ? p : 'default'
}

/** Read a numeric SQL column, coercing NULL/undefined to 0. */
function num(r: Record<string, unknown>, key: string): number {
  return (r[key] as number) || 0
}

export function createSqliteTokenStore(db: Database): TokenStore {
  // INSERT OR IGNORE: the (conversation_id, uuid) UNIQUE constraint makes this a
  // no-op when the same assistant message is seen again (isInitial transcript
  // re-reads on reconnect/restart, or Phase-3 backfill overlapping live rows).
  const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO token_samples
      (uuid, timestamp, conversation_id, sentinel_id, profile, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cache_write_5m_tokens, cache_write_1h_tokens)
    VALUES
      ($uuid, $timestamp, $conversationId, $sentinelId, $profile, $model,
       $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens,
       $cacheWrite5mTokens, $cacheWrite1hTokens)
  `)

  const stmtPrune = db.prepare('DELETE FROM token_samples WHERE timestamp < $cutoff')

  function recordSample(s: TokenSampleInput): boolean {
    const result = stmtInsert.run({
      uuid: s.uuid,
      timestamp: s.timestamp,
      conversationId: s.conversationId,
      sentinelId: s.sentinelId ?? '',
      profile: profileBucket(s.profile),
      model: s.model ?? '',
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheWriteTokens: s.cacheWriteTokens,
      cacheWrite5mTokens: s.cacheWrite5mTokens,
      cacheWrite1hTokens: s.cacheWrite1hTokens,
    })
    return (result.changes ?? 0) > 0
  }

  function queryBuckets(filter: TokenBucketFilter): TokenBucket[] {
    const perProfile = filter.groupBy === 'profile'
    const binds: Binds = { from: filter.from, to: filter.to, bucketMs: filter.bucketMs }

    const conditions = ['timestamp >= $from', 'timestamp <= $to']
    if (filter.sentinelId) {
      conditions.push('sentinel_id = $sentinelId')
      binds.sentinelId = filter.sentinelId
    }
    if (filter.profile) {
      conditions.push('profile = $profile')
      binds.profile = filter.profile
    }
    if (filter.conversationId) {
      conditions.push('conversation_id = $conversationId')
      binds.conversationId = filter.conversationId
    }

    // Integer bucket flooring. timestamp + bucketMs are both INTEGER so the
    // division is integer division; CAST is belt-and-suspenders.
    const bucketExpr = 'CAST(timestamp / $bucketMs AS INTEGER) * $bucketMs'
    const groupCols = perProfile
      ? `${bucketExpr} AS bucket_start, sentinel_id, profile`
      : `${bucketExpr} AS bucket_start`
    const groupBy = perProfile ? 'bucket_start, sentinel_id, profile' : 'bucket_start'

    const rows = queryAll(
      db,
      `SELECT ${groupCols},
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
        SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
        COUNT(*) AS samples
      FROM token_samples
      WHERE ${conditions.join(' AND ')}
      GROUP BY ${groupBy}
      ORDER BY bucket_start`,
      binds,
    ) as Array<Record<string, unknown>>

    return rows.map(r => ({
      bucketStart: num(r, 'bucket_start'),
      sentinelId: perProfile ? (r.sentinel_id as string) || '' : '',
      profile: perProfile ? (r.profile as string) || 'default' : '',
      inputTokens: num(r, 'input_tokens'),
      outputTokens: num(r, 'output_tokens'),
      cacheReadTokens: num(r, 'cache_read_tokens'),
      cacheWriteTokens: num(r, 'cache_write_tokens'),
      cacheWrite5mTokens: num(r, 'cache_write_5m_tokens'),
      cacheWrite1hTokens: num(r, 'cache_write_1h_tokens'),
      samples: num(r, 'samples'),
    }))
  }

  function pruneOlderThan(cutoffMs: number): number {
    return stmtPrune.run({ cutoff: cutoffMs }).changes ?? 0
  }

  function backfillFromTranscripts(sinceMs: number): number {
    // conversation -> latest (sentinelId, profile) from the cost `turns` table.
    // Last write wins as we scan in timestamp order, so we end on the most
    // recent attribution. Conversations with no turns are absent -> defaults.
    const attribution = new Map<string, { sentinelId: string; profile: string }>()
    const turnRows = queryAll(
      db,
      'SELECT conversation_id, sentinel_id, profile FROM turns WHERE timestamp >= $since ORDER BY timestamp',
      { since: sinceMs },
    ) as Array<Record<string, unknown>>
    for (const r of turnRows) {
      attribution.set(r.conversation_id as string, {
        sentinelId: (r.sentinel_id as string) || '',
        profile: (r.profile as string) || 'default',
      })
    }

    const entryRows = queryAll(
      db,
      `SELECT conversation_id, uuid, content, timestamp FROM transcript_entries
       WHERE type = 'assistant' AND timestamp >= $since`,
      { since: sinceMs },
    ) as Array<Record<string, unknown>>

    let inserted = 0
    const run = db.transaction(() => {
      for (const row of entryRows) {
        const sample = parseEntryUsage(row.content as string)
        if (!sample) continue
        const attr = attribution.get(row.conversation_id as string)
        const ok = recordSample({
          uuid: row.uuid as string,
          timestamp: row.timestamp as number,
          conversationId: row.conversation_id as string,
          sentinelId: attr?.sentinelId ?? '',
          profile: attr?.profile ?? 'default',
          model: sample.model,
          inputTokens: sample.inputTokens,
          outputTokens: sample.outputTokens,
          cacheReadTokens: sample.cacheReadTokens,
          cacheWriteTokens: sample.cacheWriteTokens,
          cacheWrite5mTokens: sample.cacheWrite5mTokens,
          cacheWrite1hTokens: sample.cacheWrite1hTokens,
        })
        if (ok) inserted++
      }
    })
    run()
    return inserted
  }

  return { recordSample, queryBuckets, pruneOlderThan, backfillFromTranscripts }
}
