/**
 * OpenRouter Spend Store -- SQLite-backed record of every OpenRouter round-trip.
 *
 * `recordOpenRouterSpend()` in recap/shared/openrouter-client.ts is the ONE sink
 * every broker feature's LLM call funnels through. It used to emit a single
 * `[openrouter]` log line and nothing else, so "which feature is eating the
 * money" was a grep over container logs -- not something a pane can render.
 * This store is the durable half of that sink: same record, same chokepoint,
 * now also a row.
 *
 * Non-critical by construction, exactly like analytics-store: a write failure is
 * logged and swallowed, never propagated. Spend accounting must never be the
 * reason a chat() call fails.
 *
 * Retention is 30 days (see RETENTION_MS), trimmed on boot and daily after. The
 * query windows stop at 30d for that reason -- offering 90d would return a
 * number that is quietly missing two thirds of its period.
 */

import type { Database, Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { NormalizedUsage } from './recap/shared/pricing'
import { openWalDatabase } from './sqlite-open'

/** One structured record per OpenRouter round-trip (success OR failure). This is
 *  both the log line's input and the stored row -- keeping it in the store means
 *  the sink stays a one-line call and no call site knows persistence exists. */
export interface OpenRouterSpendRecord {
  /** WHICH broker feature spent (the `feature` tag on the ChatRequest). */
  feature: string
  /** Model as REQUESTED (req.model; the response's resolved model lives in usage forensics). */
  model: string
  /** Wall-clock ms for the whole call incl. retries. */
  ms: number
  /** true = billed a usable completion; false = errored/timed-out (no usable tokens). */
  ok: boolean
  /** Normalised token counts + billed cost. Present on success only. */
  usage?: NormalizedUsage
  /** Failure message. Present when ok=false. */
  error?: string
}

/** Query windows. Capped at the retention bound on purpose -- a 90d window over
 *  a 30d table is a wrong number with a confident label. */
export type SpendPeriod = '24h' | '7d' | '30d'

/** Rollup row. `costUsd` counts SUCCESSFUL calls only: a failed call returns no
 *  usage body, so its provider-side cost (if any) is unknowable here. `failedMs`
 *  is the honest proxy for money burnt on timeouts and retries. */
export interface SpendGroup {
  /** feature name (by-feature rollup) or model slug (by-model rollup). */
  key: string
  calls: number
  failedCalls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalMs: number
  /** Wall-clock ms spent on calls that produced nothing. */
  failedMs: number
  /** Calls whose cost came from the LiteLLM price table, not OpenRouter's billed
   *  amount. Non-zero means part of `costUsd` is an ESTIMATE. */
  estimatedCalls: number
}

export interface SpendRollup {
  period: SpendPeriod
  from: number
  to: number
  /** Set when the rollup was scoped to one feature (by-model drill-down). */
  feature?: string
  totals: Omit<SpendGroup, 'key'>
  byFeature: SpendGroup[]
  byModel: SpendGroup[]
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

let db: Database | null = null
let stmtInsert: Statement | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null

// ─── Init ───────────────────────────────────────────────────────────

export function initOpenRouterSpendStore(cacheDir: string): void {
  try {
    const dbPath = resolve(cacheDir, 'openrouter-spend.db')
    db = openWalDatabase(dbPath)

    db.run(`
      CREATE TABLE IF NOT EXISTS openrouter_spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        ms INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_source TEXT NOT NULL DEFAULT 'unknown',
        error TEXT
      )
    `)
    db.run('CREATE INDEX IF NOT EXISTS idx_or_spend_ts ON openrouter_spend(ts)')
    db.run('CREATE INDEX IF NOT EXISTS idx_or_spend_feature ON openrouter_spend(feature, ts)')

    stmtInsert = db.prepare(`
      INSERT INTO openrouter_spend
        (ts, feature, model, ms, ok, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, cost_source, error)
      VALUES
        ($ts, $feature, $model, $ms, $ok, $inputTokens, $outputTokens,
         $cacheReadTokens, $cacheWriteTokens, $costUsd, $costSource, $error)
    `)

    trimOpenRouterSpend()
    cleanupTimer = setInterval(() => trimOpenRouterSpend(), CLEANUP_INTERVAL_MS)

    const count = (db.query('SELECT COUNT(*) as n FROM openrouter_spend').get() as { n: number }).n
    console.log(`[openrouter] Spend store initialized: ${dbPath} (${count} calls)`)
  } catch (err) {
    console.error('[openrouter] Failed to initialize spend store:', err)
    db = null
    stmtInsert = null
  }
}

// ─── Write ──────────────────────────────────────────────────────────

/**
 * Persist one round-trip. A no-op when the store was never initialized (unit
 * tests, the CLI, anything that imports the client without a broker) -- the
 * `[openrouter]` log line is emitted by the caller either way, so an uninitialized
 * store degrades to exactly the old behaviour instead of throwing.
 *
 * `at` is a test seam: it lets a test place rows in the past to exercise the
 * window and retention maths without sleeping.
 */
export function recordSpend(rec: OpenRouterSpendRecord, at: number = Date.now()): void {
  if (!stmtInsert) return
  try {
    const u = rec.usage
    stmtInsert.run({
      ts: at,
      feature: rec.feature,
      model: rec.model,
      ms: Math.round(rec.ms),
      ok: rec.ok ? 1 : 0,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      cacheReadTokens: u?.cacheReadTokens ?? 0,
      cacheWriteTokens: u?.cacheWriteTokens ?? 0,
      costUsd: u?.costUsd ?? 0,
      costSource: u?.costSource ?? 'unknown',
      error: rec.error ?? null,
    })
  } catch (err) {
    console.error('[openrouter] Spend write failed:', err)
  }
}

// ─── Queries ────────────────────────────────────────────────────────

const GROUP_COLUMNS = `
  COUNT(*) as calls,
  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as failed_calls,
  COALESCE(SUM(cost_usd), 0) as cost_usd,
  COALESCE(SUM(input_tokens), 0) as input_tokens,
  COALESCE(SUM(output_tokens), 0) as output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
  COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
  COALESCE(SUM(ms), 0) as total_ms,
  COALESCE(SUM(CASE WHEN ok = 0 THEN ms ELSE 0 END), 0) as failed_ms,
  SUM(CASE WHEN cost_source = 'litellm' THEN 1 ELSE 0 END) as estimated_calls
`

/**
 * Spend over a window: by feature, and by model. Pass `feature` to scope the
 * by-model breakdown to one feature (the drill-down `wall-pane-burn` needs);
 * `byFeature` stays fleet-wide either way so the pane keeps its context.
 */
export function querySpendRollup(period: SpendPeriod, feature?: string, now: number = Date.now()): SpendRollup {
  const from = now - periodToMs(period)
  const byFeature = groupRows('feature', from, undefined)
  const byModel = groupRows('model', from, feature)
  return {
    period,
    from,
    to: now,
    ...(feature ? { feature } : {}),
    // Totals are summed from the by-feature rows, not re-queried: one aggregation
    // path means the header can never disagree with the table under it.
    totals: sumGroups(byFeature),
    byFeature,
    byModel,
  }
}

function groupRows(column: 'feature' | 'model', from: number, feature: string | undefined): SpendGroup[] {
  if (!db) return []
  const where = feature ? 'WHERE ts >= $from AND feature = $feature' : 'WHERE ts >= $from'
  const binds = feature ? { from, feature } : { from }
  const rows = db
    .query(
      `SELECT ${column} as key, ${GROUP_COLUMNS}
       FROM openrouter_spend ${where}
       GROUP BY ${column}
       ORDER BY cost_usd DESC, calls DESC`,
    )
    .all(binds as never) as Array<Record<string, number | string>>
  return rows.map(toSpendGroup)
}

function toSpendGroup(r: Record<string, number | string>): SpendGroup {
  return {
    key: String(r.key),
    calls: Number(r.calls),
    failedCalls: Number(r.failed_calls),
    costUsd: Number(r.cost_usd),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    totalMs: Number(r.total_ms),
    failedMs: Number(r.failed_ms),
    estimatedCalls: Number(r.estimated_calls),
  }
}

function sumGroups(groups: SpendGroup[]): Omit<SpendGroup, 'key'> {
  const total = {
    calls: 0,
    failedCalls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalMs: 0,
    failedMs: 0,
    estimatedCalls: 0,
  }
  for (const g of groups) {
    total.calls += g.calls
    total.failedCalls += g.failedCalls
    total.costUsd += g.costUsd
    total.inputTokens += g.inputTokens
    total.outputTokens += g.outputTokens
    total.cacheReadTokens += g.cacheReadTokens
    total.cacheWriteTokens += g.cacheWriteTokens
    total.totalMs += g.totalMs
    total.failedMs += g.failedMs
    total.estimatedCalls += g.estimatedCalls
  }
  return total
}

function periodToMs(period: SpendPeriod): number {
  switch (period) {
    case '24h':
      return 24 * 60 * 60 * 1000
    case '7d':
      return 7 * 24 * 60 * 60 * 1000
    default:
      return 30 * 24 * 60 * 60 * 1000
  }
}

// ─── Retention ──────────────────────────────────────────────────────

/** Drop rows past the 30-day bound. Returns the number deleted (the test asserts
 *  on it; the boot path ignores it). Exported so the bound is verifiable, not
 *  merely documented. */
export function trimOpenRouterSpend(now: number = Date.now()): number {
  if (!db) return 0
  try {
    const cutoff = now - RETENTION_MS
    const result = db.prepare('DELETE FROM openrouter_spend WHERE ts < $cutoff').run({ cutoff })
    const deleted = (result as unknown as { changes: number } | undefined)?.changes ?? 0
    if (deleted > 0) console.log(`[openrouter] Spend cleanup: removed ${deleted} calls older than 30d`)
    return deleted
  } catch (err) {
    console.error('[openrouter] Spend cleanup failed:', err)
    return 0
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

export function closeOpenRouterSpendStore(): void {
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = null
  if (db) {
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (err) {
      console.error('[openrouter] Error closing spend store:', err)
    }
  }
  db = null
  stmtInsert = null
}
