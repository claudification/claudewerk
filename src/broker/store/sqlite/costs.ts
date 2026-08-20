import type { Database } from 'bun:sqlite'
import { normalizeProjectUri } from '../../../shared/project-uri'
import type {
  CostPeriod,
  CostStore,
  CostSummary,
  CumulativeTurnInput,
  HourlyFilter,
  HourlyRow,
  ProfileBreakdownFilter,
  ProfileBreakdownRow,
  TurnActivityRow,
  TurnFilter,
  TurnRecord,
} from '../types'
import { type Binds, queryAll, queryGet } from './query'

function normalizeUri(uri: string): string {
  if (!uri) return uri
  try {
    return normalizeProjectUri(uri)
  } catch {
    return uri
  }
}

/** Conversation ids per `IN (...)` batch. SQLite's default ceiling is 999 bound
 *  variables per statement; 500 leaves room and keeps the plan cache small. */
const SUM_CHUNK = 500

function toHourKey(ms: number): string {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function periodToMs(period: CostPeriod): number {
  switch (period) {
    case '24h':
      return 24 * 60 * 60 * 1000
    case '7d':
      return 7 * 24 * 60 * 60 * 1000
    case '30d':
      return 30 * 24 * 60 * 60 * 1000
  }
}

function mapHourlyRow(r: Record<string, unknown>): HourlyRow {
  return {
    hour: r.hour as string,
    account: r.account as string,
    model: r.model as string,
    projectUri: (r.project_uri as string) || '',
    turnCount: r.turn_count as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    costUsd: r.cost_usd as number,
    sentinelId: (r.sentinel_id as string) || '',
    profile: (r.profile as string) || 'default',
  }
}

/** Normalise profile to its bucket name. Empty / undefined -> 'default'. */
function profileBucket(p: string | null | undefined): string {
  return p && p.length > 0 ? p : 'default'
}

/** Shared WHERE-clause builder for `turns` queries. Extracted from queryTurns
 *  so the per-call function stays under the complexity gate after Phase 5
 *  added sentinelId / profile filters. */
function buildTurnFilterClauses(filter: TurnFilter): { conditions: string[]; binds: Binds } {
  const conditions: string[] = []
  const binds: Binds = {}
  if (filter.from) {
    conditions.push('timestamp >= $from')
    binds.from = filter.from
  }
  if (filter.to) {
    conditions.push('timestamp <= $to')
    binds.to = filter.to
  }
  if (filter.account) {
    conditions.push('account = $account')
    binds.account = filter.account
  }
  if (filter.model) {
    conditions.push('model LIKE $model')
    binds.model = `%${filter.model}%`
  }
  if (filter.projectUri) {
    conditions.push('project_uri = $projectUri')
    binds.projectUri = filter.projectUri
  }
  if (filter.sentinelId) {
    conditions.push('sentinel_id = $sentinelId')
    binds.sentinelId = filter.sentinelId
  }
  if (filter.profile) {
    conditions.push('profile = $profile')
    binds.profile = filter.profile
  }
  return { conditions, binds }
}

/** Shared WHERE-clause builder for `hourly_stats` queries. Same shape as
 *  buildTurnFilterClauses but keys timestamp filters off the `hour` column
 *  (toHourKey-encoded TEXT) instead of raw epoch ms. */
function buildHourlyFilterClauses(filter: HourlyFilter): { conditions: string[]; binds: Binds } {
  const conditions: string[] = []
  const binds: Binds = {}
  if (filter.from) {
    conditions.push('hour >= $from')
    binds.from = toHourKey(filter.from)
  }
  if (filter.to) {
    conditions.push('hour <= $to')
    binds.to = toHourKey(filter.to)
  }
  if (filter.account) {
    conditions.push('account = $account')
    binds.account = filter.account
  }
  if (filter.model) {
    conditions.push('model LIKE $model')
    binds.model = `%${filter.model}%`
  }
  if (filter.projectUri) {
    conditions.push('project_uri = $projectUri')
    binds.projectUri = filter.projectUri
  }
  if (filter.sentinelId) {
    conditions.push('sentinel_id = $sentinelId')
    binds.sentinelId = filter.sentinelId
  }
  if (filter.profile) {
    conditions.push('profile = $profile')
    binds.profile = filter.profile
  }
  return { conditions, binds }
}

interface ConversationSnapshot {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export function createSqliteCostStore(db: Database): CostStore {
  const stmtInsertTurn = db.prepare(`
    INSERT INTO turns (timestamp, conversation_id, project_uri, account, org_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, exact_cost, sentinel_id, profile)
    VALUES ($timestamp, $conversationId, $projectUri, $account, $orgId, $model,
      $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens,
      $costUsd, $exactCost, $sentinelId, $profile)
  `)

  const stmtDeleteOldTurns = db.prepare('DELETE FROM turns WHERE timestamp < $cutoff')
  const stmtDeleteOldHourly = db.prepare('DELETE FROM hourly_stats WHERE hour < $cutoffHour')

  // The hourly_stats PK is (hour, account, model, project_uri). project_uri already
  // encodes the profile via its userinfo slot, so adding sentinel_id/profile to
  // the SELECT doesn't change the grouping -- they're denormalized convenience
  // columns. INSERT OR REPLACE keeps PK semantics intact; MIN()/MAX() over a
  // PK-deterministic group picks the single value present.
  const stmtMaterializeHourly = db.prepare(
    `INSERT OR REPLACE INTO hourly_stats (hour, account, model, project_uri,
      turn_count, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost_usd, sentinel_id, profile)
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch') as hour,
      account, model, COALESCE(project_uri, '') as project_uri,
      COUNT(*) as turn_count,
      SUM(input_tokens), SUM(output_tokens),
      SUM(cache_read_tokens), SUM(cache_write_tokens),
      SUM(cost_usd),
      COALESCE(MIN(sentinel_id), '') as sentinel_id,
      COALESCE(MIN(profile), 'default') as profile
    FROM turns
    WHERE timestamp >= $start AND timestamp <= $end
      AND strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch') != $currentHour
    GROUP BY hour, account, model, project_uri`,
  )

  // Per-conversation cumulative snapshots live in memory -- cheap, reset on restart.
  // After a restart the first turn becomes an outlier (full cumulative as delta);
  // this matches the behavior of the old file-level cost-store.ts.
  const lastSnapshot = new Map<string, ConversationSnapshot>()

  function materializeHourly(from?: number, to?: number): void {
    const cutoffFrom = from ?? Date.now() - 31 * 24 * 60 * 60 * 1000
    const cutoffTo = to ?? Date.now()
    const currentHour = toHourKey(Date.now())
    stmtMaterializeHourly.run({ start: cutoffFrom, end: cutoffTo, currentHour })
  }

  function recordTurn(record: TurnRecord): void {
    stmtInsertTurn.run({
      timestamp: record.timestamp,
      conversationId: record.conversationId,
      projectUri: normalizeUri(record.projectUri),
      account: record.account,
      orgId: record.orgId,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
      costUsd: record.costUsd,
      exactCost: record.exactCost ? 1 : 0,
      sentinelId: record.sentinelId ?? '',
      profile: profileBucket(record.profile),
    })
  }

  function recordTurnFromCumulatives(params: CumulativeTurnInput): boolean {
    const prev = lastSnapshot.get(params.conversationId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    }

    const dIn = params.totalInputTokens - prev.inputTokens
    const dOut = params.totalOutputTokens - prev.outputTokens
    const dCR = params.totalCacheRead - prev.cacheRead
    const dCW = params.totalCacheWrite - prev.cacheWrite
    const dCost = params.totalCostUsd - prev.costUsd

    if (dIn <= 0 && dOut <= 0) return false

    recordTurn({
      timestamp: params.timestamp,
      conversationId: params.conversationId,
      projectUri: normalizeUri(params.projectUri),
      account: params.account,
      orgId: params.orgId,
      model: params.model,
      inputTokens: dIn,
      outputTokens: dOut,
      cacheReadTokens: dCR,
      cacheWriteTokens: dCW,
      costUsd: Math.max(0, dCost),
      exactCost: params.exactCost,
      sentinelId: params.sentinelId,
      profile: params.profile,
    })

    lastSnapshot.set(params.conversationId, {
      inputTokens: params.totalInputTokens,
      outputTokens: params.totalOutputTokens,
      cacheRead: params.totalCacheRead,
      cacheWrite: params.totalCacheWrite,
      costUsd: params.totalCostUsd,
    })
    return true
  }

  function queryTurns(filter: TurnFilter): { rows: TurnRecord[]; total: number } {
    const { conditions, binds } = buildTurnFilterClauses(filter)

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(filter.limit ?? 100, 1000)
    const offset = filter.offset ?? 0

    const countRow = queryGet(db, `SELECT COUNT(*) as n FROM turns ${where}`, binds) as { n: number }
    const rows = queryAll(
      db,
      `SELECT timestamp, conversation_id, COALESCE(project_uri, '') as project_uri,
      account, org_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, exact_cost, sentinel_id, profile
      FROM turns ${where} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
      binds,
    ) as Array<Record<string, unknown>>

    return {
      total: countRow.n,
      rows: rows.map(r => ({
        timestamp: r.timestamp as number,
        conversationId: r.conversation_id as string,
        projectUri: (r.project_uri as string) || '',
        account: r.account as string,
        orgId: r.org_id as string,
        model: r.model as string,
        inputTokens: r.input_tokens as number,
        outputTokens: r.output_tokens as number,
        cacheReadTokens: r.cache_read_tokens as number,
        cacheWriteTokens: r.cache_write_tokens as number,
        costUsd: r.cost_usd as number,
        exactCost: !!(r.exact_cost as number),
        sentinelId: (r.sentinel_id as string) || '',
        profile: (r.profile as string) || 'default',
      })),
    }
  }

  function queryHourly(filter: HourlyFilter): HourlyRow[] {
    materializeHourly(filter.from, filter.to)

    const { conditions, binds } = buildHourlyFilterClauses(filter)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    if (filter.groupBy === 'day') {
      const rows = queryAll(
        db,
        `SELECT substr(hour, 1, 10) as hour, account, model,
        MIN(project_uri) as project_uri,
        SUM(turn_count) as turn_count, SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens, SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens, SUM(cost_usd) as cost_usd,
        COALESCE(MIN(sentinel_id), '') as sentinel_id,
        COALESCE(MIN(profile), 'default') as profile
        FROM hourly_stats ${where}
        GROUP BY substr(hour, 1, 10), account, model
        ORDER BY hour`,
        binds,
      ) as Array<Record<string, unknown>>
      return rows.map(mapHourlyRow)
    }

    const rows = queryAll(db, `SELECT * FROM hourly_stats ${where} ORDER BY hour`, binds) as Array<
      Record<string, unknown>
    >
    return rows.map(mapHourlyRow)
  }

  function queryProfileBreakdown(filter?: ProfileBreakdownFilter): ProfileBreakdownRow[] {
    const conditions: string[] = []
    const binds: Binds = {}
    const from = filter?.from ?? Date.now() - 30 * 24 * 60 * 60 * 1000
    const to = filter?.to ?? Date.now()
    conditions.push('timestamp >= $from', 'timestamp <= $to')
    binds.from = from
    binds.to = to
    if (filter?.sentinelId) {
      conditions.push('sentinel_id = $sentinelId')
      binds.sentinelId = filter.sentinelId
    }
    const where = `WHERE ${conditions.join(' AND ')}`
    const rows = queryAll(
      db,
      `SELECT COALESCE(sentinel_id, '') as sentinel_id,
        COALESCE(NULLIF(profile, ''), 'default') as profile,
        SUM(cost_usd) as cost_usd,
        COUNT(*) as turns,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens
      FROM turns ${where}
      GROUP BY sentinel_id, profile
      ORDER BY cost_usd DESC`,
      binds,
    ) as Array<Record<string, unknown>>
    return rows.map(r => ({
      sentinelId: (r.sentinel_id as string) || '',
      profile: (r.profile as string) || 'default',
      costUsd: r.cost_usd as number,
      turns: r.turns as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
    }))
  }

  /** The day-bucketing read. Index-ordered by timestamp so the caller can walk
   *  it against a sorted day axis without re-sorting. */
  function queryTurnActivity(from: number, to: number): TurnActivityRow[] {
    const rows = queryAll(
      db,
      `SELECT timestamp,
        (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as tokens,
        cost_usd, exact_cost
      FROM turns WHERE timestamp >= $from AND timestamp <= $to ORDER BY timestamp`,
      { from, to },
    ) as Array<Record<string, unknown>>
    return rows.map(r => ({
      timestamp: r.timestamp as number,
      tokens: (r.tokens as number) || 0,
      costUsd: (r.cost_usd as number) || 0,
      exactCost: !!(r.exact_cost as number),
    }))
  }

  function querySummary(period: CostPeriod): CostSummary {
    const cutoff = Date.now() - periodToMs(period)
    const b = { cutoff }

    const totals = queryGet(
      db,
      `SELECT COUNT(*) as turns,
      COALESCE(SUM(cost_usd), 0) as cost,
      COALESCE(SUM(input_tokens), 0) as input_t,
      COALESCE(SUM(output_tokens), 0) as output_t,
      COALESCE(SUM(cache_read_tokens), 0) as cache_r,
      COALESCE(SUM(cache_write_tokens), 0) as cache_w
      FROM turns WHERE timestamp >= $cutoff`,
      b,
    ) as Record<string, number>

    const topProjects = queryAll(
      db,
      `SELECT project_uri, SUM(cost_usd) as cost, COUNT(*) as turns
      FROM turns WHERE timestamp >= $cutoff
      GROUP BY project_uri ORDER BY cost DESC LIMIT 10`,
      b,
    ) as Array<{ project_uri: string; cost: number; turns: number }>

    const topModels = queryAll(
      db,
      `SELECT model, SUM(cost_usd) as cost, COUNT(*) as turns
      FROM turns WHERE timestamp >= $cutoff
      GROUP BY model ORDER BY cost DESC LIMIT 10`,
      b,
    ) as Array<{ model: string; cost: number; turns: number }>

    const profileRows = queryAll(
      db,
      `SELECT COALESCE(sentinel_id, '') as sentinel_id,
        COALESCE(NULLIF(profile, ''), 'default') as profile,
        SUM(cost_usd) as cost,
        COUNT(*) as turns,
        SUM(input_tokens) as input_t,
        SUM(output_tokens) as output_t,
        SUM(cache_read_tokens) as cache_r,
        SUM(cache_write_tokens) as cache_w
      FROM turns WHERE timestamp >= $cutoff
      GROUP BY sentinel_id, profile ORDER BY cost DESC`,
      b,
    ) as Array<Record<string, unknown>>

    return {
      period,
      totalCostUsd: totals.cost,
      totalTurns: totals.turns,
      totalInputTokens: totals.input_t,
      totalOutputTokens: totals.output_t,
      totalCacheReadTokens: totals.cache_r,
      totalCacheWriteTokens: totals.cache_w,
      topProjects: topProjects.map(p => ({
        projectUri: p.project_uri || '',
        costUsd: p.cost,
        turns: p.turns,
      })),
      topModels: topModels.map(m => ({ model: m.model, costUsd: m.cost, turns: m.turns })),
      profiles: profileRows.map(r => ({
        sentinelId: (r.sentinel_id as string) || '',
        profile: (r.profile as string) || 'default',
        costUsd: (r.cost as number) || 0,
        turns: (r.turns as number) || 0,
        inputTokens: (r.input_t as number) || 0,
        outputTokens: (r.output_t as number) || 0,
        cacheReadTokens: (r.cache_r as number) || 0,
        cacheWriteTokens: (r.cache_w as number) || 0,
      })),
    }
  }

  /**
   * Total USD over a set of conversations -- the epic engine's spend ledger.
   *
   * Chunked because SQLite caps a statement at 999 bound variables and an epic
   * run accumulates one conversation per seat: an epic with forty cards, each
   * implemented, bounced and re-verified, is well past that. A silent truncation
   * here would under-report a run's cost, which is the one direction a spend CAP
   * must never be wrong in.
   *
   * Needs `idx_turns_conversation` (schema.ts). Without it this is a full scan of
   * a multi-gigabyte table once per epic per 45s tick.
   */
  function sumCostByConversations(conversationIds: readonly string[]): number {
    if (conversationIds.length === 0) return 0
    let total = 0
    for (let i = 0; i < conversationIds.length; i += SUM_CHUNK) {
      const chunk = conversationIds.slice(i, i + SUM_CHUNK)
      const binds: Binds = {}
      const names = chunk.map((id, n) => {
        binds[`c${n}`] = id
        return `$c${n}`
      })
      const row = queryGet(
        db,
        `SELECT COALESCE(SUM(cost_usd), 0) as cost FROM turns WHERE conversation_id IN (${names.join(', ')})`,
        binds,
      ) as { cost: number } | undefined
      total += Number(row?.cost ?? 0)
    }
    return total
  }

  function pruneOlderThan(cutoffMs: number): { turns: number; hourly: number } {
    const cutoffHour = toHourKey(cutoffMs)
    const turnsResult = stmtDeleteOldTurns.run({ cutoff: cutoffMs })
    const hourlyResult = stmtDeleteOldHourly.run({ cutoffHour })
    return { turns: turnsResult.changes ?? 0, hourly: hourlyResult.changes ?? 0 }
  }

  return {
    recordTurn,
    recordTurnFromCumulatives,
    queryTurns,
    queryHourly,
    querySummary,
    queryProfileBreakdown,
    sumCostByConversations,
    queryTurnActivity,
    pruneOlderThan,
  }
}
