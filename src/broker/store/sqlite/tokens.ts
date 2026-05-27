import type { Database } from 'bun:sqlite'
import type { TokenBucket, TokenBucketFilter, TokenSampleInput, TokenStore } from '../types'

type Binds = Record<string, string | number | null>

function queryAll(db: Database, sql: string, binds?: Binds): unknown[] {
  const stmt = db.query(sql)
  return binds ? stmt.all(binds as never) : stmt.all()
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
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    VALUES
      ($uuid, $timestamp, $conversationId, $sentinelId, $profile, $model,
       $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens)
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
      samples: num(r, 'samples'),
    }))
  }

  function pruneOlderThan(cutoffMs: number): number {
    return stmtPrune.run({ cutoff: cutoffMs }).changes ?? 0
  }

  return { recordSample, queryBuckets, pruneOlderThan }
}
