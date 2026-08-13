/**
 * slow-query-log - time every SQLite call the broker makes and report the ones
 * that cross a threshold.
 *
 * bun:sqlite is SYNCHRONOUS. A query that takes 300ms does not just make one
 * request slow, it blocks the broker's entire event loop for 300ms -- every
 * other HTTP request, every WebSocket frame, every timer waits behind it. With
 * a 9.4GB store.db that is the difference between a panel that populates
 * instantly and one that appears to hang. Nothing in the broker measured this,
 * so a slow query was indistinguishable from a slow network.
 *
 * Instrumentation wraps the single Database instance the store driver creates,
 * so every store (conversations, transcripts, events, ...) is covered without
 * touching a single call site.
 */

/** One query that crossed the threshold. */
export interface SlowQuery {
  sql: string
  ms: number
  /** Rows returned, or -1 when the call does not report a count. */
  rows: number
  /** Which method ran it: all / get / run / values / iterate / exec. */
  method: string
}

/** Rolling aggregate for one distinct SQL string. */
export interface QueryStat {
  sql: string
  count: number
  totalMs: number
  maxMs: number
}

export interface InstrumentOptions {
  /** Log anything at or above this. 0 disables instrumentation entirely. */
  thresholdMs: number
  onSlow?: (q: SlowQuery) => void
  now?: () => number
}

/** Collapse whitespace and clip, so one query is one grep-able line. */
export function normalizeSql(sql: string, maxLength = 200): string {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}...` : flat
}

export function formatSlowQuery(q: SlowQuery): string {
  const rows = q.rows >= 0 ? ` rows=${q.rows}` : ''
  return `[slow-query] ${q.ms.toFixed(1)}ms ${q.method}${rows} -- ${normalizeSql(q.sql)}`
}

/** Aggregates across every timed call, for the periodic summary. */
export class QueryStats {
  private readonly bySql = new Map<string, QueryStat>()

  record(sql: string, ms: number): void {
    const key = normalizeSql(sql)
    const existing = this.bySql.get(key)
    if (!existing) {
      this.bySql.set(key, { sql: key, count: 1, totalMs: ms, maxMs: ms })
      return
    }
    existing.count++
    existing.totalMs += ms
    existing.maxMs = Math.max(existing.maxMs, ms)
  }

  /** Worst offenders by TOTAL time -- a fast query run 10k times is the bug. */
  top(n: number): QueryStat[] {
    return [...this.bySql.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, n)
  }

  reset(): void {
    this.bySql.clear()
  }
}

export function formatStatsSummary(stats: QueryStat[]): string {
  if (stats.length === 0) return '[query-stats] nothing recorded'
  const lines = stats.map(
    s => `  ${s.totalMs.toFixed(0)}ms total / ${s.count}x / ${s.maxMs.toFixed(0)}ms worst -- ${s.sql}`,
  )
  return `[query-stats] top ${stats.length} by total time:\n${lines.join('\n')}`
}

/** Statement methods that actually execute SQL. */
const TIMED_STATEMENT_METHODS = new Set(['all', 'get', 'run', 'values', 'iterate'])

/** Only an array tells us how many rows came back; everything else is unknown. */
function rowCountOf(result: unknown): number {
  return Array.isArray(result) ? result.length : -1
}

interface Timer {
  thresholdMs: number
  now: () => number
  stats: QueryStats
  onSlow: (q: SlowQuery) => void
}

/** Run `call`, time it, record it, and report it when it crosses the line. */
function timed(timer: Timer, sql: string, method: string, call: () => unknown): unknown {
  const started = timer.now()
  let result: unknown
  try {
    result = call()
    return result
  } finally {
    const ms = timer.now() - started
    timer.stats.record(sql, ms)
    if (ms >= timer.thresholdMs) {
      timer.onSlow({ sql, ms, rows: rowCountOf(result), method })
    }
  }
}

/**
 * Bind a non-timed member so the underlying object keeps its `this`. Proxy
 * `get` hands back a raw function otherwise, and bun:sqlite's natives throw
 * when invoked detached.
 */
function passThrough(value: unknown, target: object): unknown {
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
}

/** Wrap one prepared Statement so its executing methods are timed. */
function wrapStatement<T extends object>(statement: T, sql: string, timer: Timer): T {
  return new Proxy(statement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || typeof prop !== 'string' || !TIMED_STATEMENT_METHODS.has(prop)) {
        return passThrough(value, target)
      }
      return (...args: unknown[]) =>
        timed(timer, sql, prop, () => (value as (...a: unknown[]) => unknown).apply(target, args))
    },
  })
}

const PREPARING_METHODS = new Set(['query', 'prepare'])
const INLINE_METHODS = new Set(['run', 'exec'])

/**
 * Wrap a Database so every query it runs is timed.
 *
 * Returns the database untouched when `thresholdMs` is 0, so the whole thing
 * can be switched off without a separate code path at the call sites.
 */
export function instrumentDatabase<T extends object>(db: T, options: InstrumentOptions): { db: T; stats: QueryStats } {
  const stats = new QueryStats()
  if (options.thresholdMs <= 0) return { db, stats }

  const timer: Timer = {
    thresholdMs: options.thresholdMs,
    now: options.now ?? (() => performance.now()),
    stats,
    onSlow: options.onSlow ?? (q => console.warn(formatSlowQuery(q))),
  }

  // Statements are usually prepared once and reused, so cache the wrapper
  // rather than allocating a Proxy per call.
  const wrappedStatements = new WeakMap<object, unknown>()

  const instrumented = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || typeof prop !== 'string') return passThrough(value, target)

      if (INLINE_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '(non-string sql)'
          return timed(timer, sql, prop, () => (value as (...a: unknown[]) => unknown).apply(target, args))
        }
      }

      if (!PREPARING_METHODS.has(prop)) return passThrough(value, target)

      return (...args: unknown[]) => {
        const statement = (value as (...a: unknown[]) => object).apply(target, args)
        if (!statement || typeof statement !== 'object') return statement
        const cached = wrappedStatements.get(statement)
        if (cached) return cached
        const sql = typeof args[0] === 'string' ? args[0] : '(non-string sql)'
        const proxy = wrapStatement(statement, sql, timer)
        wrappedStatements.set(statement, proxy)
        return proxy
      }
    },
  })

  return { db: instrumented, stats }
}
