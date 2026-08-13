/**
 * The instrumentation sits in front of EVERY query the broker runs, so the bar
 * is higher than "does it log": it must be transparent. A wrapper that changes
 * a return value, breaks named-parameter binding, or detaches `this` from a
 * bun:sqlite native would corrupt data everywhere at once.
 *
 * These run against a real bun:sqlite Database for that reason -- a hand-rolled
 * fake would happily pass while the Proxy broke the real thing.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  formatSlowQuery,
  formatStatsSummary,
  instrumentDatabase,
  normalizeSql,
  QueryStats,
  type SlowQuery,
} from '../slow-query-log'

let raw: Database

beforeEach(() => {
  raw = new Database(':memory:', { strict: true })
  raw.run('CREATE TABLE conv (id TEXT PRIMARY KEY, title TEXT, n INTEGER)')
  const insert = raw.prepare('INSERT INTO conv (id, title, n) VALUES ($id, $title, $n)')
  for (let i = 0; i < 25; i++) insert.run({ id: `c${i}`, title: `conv ${i}`, n: i })
})

afterEach(() => {
  raw.close()
})

function instrument(thresholdMs: number, clock?: () => number) {
  const seen: SlowQuery[] = []
  const { db, stats } = instrumentDatabase(raw, { thresholdMs, onSlow: q => seen.push(q), now: clock })
  return { db, stats, seen }
}

describe('transparency', () => {
  test('query results are identical to the uninstrumented database', () => {
    const { db } = instrument(1)
    const expected = raw.query('SELECT id, n FROM conv WHERE n < 5 ORDER BY n').all()
    const actual = db.query('SELECT id, n FROM conv WHERE n < 5 ORDER BY n').all()
    expect(actual).toEqual(expected)
  })

  test('named parameter binding still works through the proxy', () => {
    // strict:true means a mis-bound param would surface as a throw or a NULL
    // row rather than silently wrong data -- either way this catches it.
    const { db } = instrument(1)
    const row = db.query('SELECT title FROM conv WHERE id = $id').get({ id: 'c7' })
    expect(row).toEqual({ title: 'conv 7' })
  })

  test('get returns a single row and run reports changes', () => {
    const { db } = instrument(1)
    expect(db.query('SELECT n FROM conv WHERE id = $id').get({ id: 'c3' })).toEqual({ n: 3 })
    const result = db.query('UPDATE conv SET n = 99 WHERE id = $id').run({ id: 'c3' })
    expect(result.changes).toBe(1)
    expect(db.query('SELECT n FROM conv WHERE id = $id').get({ id: 'c3' })).toEqual({ n: 99 })
  })

  test('non-function members and unrelated methods pass through intact', () => {
    const { db } = instrument(1)
    expect(db.filename).toBe(raw.filename)
    // `transaction` is not timed, but must still be callable and effective.
    const insertMany = db.transaction((rows: Array<{ id: string }>) => {
      for (const r of rows) db.query('INSERT INTO conv (id, n) VALUES ($id, 0)').run({ id: r.id })
      return rows.length
    })
    expect(insertMany([{ id: 'tx1' }, { id: 'tx2' }])).toBe(2)
    expect(db.query('SELECT COUNT(*) AS c FROM conv').get()).toEqual({ c: 27 })
  })

  test('a threshold of 0 returns the database untouched', () => {
    const { db } = instrument(0)
    expect(db).toBe(raw)
  })
})

describe('slow query reporting', () => {
  test('reports a query that crosses the threshold, with rows and method', () => {
    let t = 0
    // Each now() call advances 60ms, so every query reads as 60ms.
    const { db, seen } = instrument(50, () => {
      t += 60
      return t
    })

    db.query('SELECT id FROM conv').all()

    expect(seen).toHaveLength(1)
    expect(seen[0].ms).toBe(60)
    expect(seen[0].method).toBe('all')
    expect(seen[0].rows).toBe(25)
    expect(seen[0].sql).toContain('SELECT id FROM conv')
  })

  test('stays silent below the threshold', () => {
    const { db, seen } = instrument(10_000)
    db.query('SELECT id FROM conv').all()
    expect(seen).toEqual([])
  })

  test('reports rows=-1 when the call cannot report a count', () => {
    let t = 0
    const { db, seen } = instrument(50, () => {
      t += 60
      return t
    })
    db.query('SELECT id FROM conv WHERE id = $id').get({ id: 'c1' })
    expect(seen[0].rows).toBe(-1)
  })

  test('a direct db.run is timed too', () => {
    let t = 0
    const { db, seen } = instrument(50, () => {
      t += 60
      return t
    })
    db.run('UPDATE conv SET n = 0')
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('run')
  })

  test('a query that throws DURING execution is still timed, not swallowed', () => {
    let t = 0
    const { db, seen, stats } = instrument(50, () => {
      t += 60
      return t
    })
    // Prepares cleanly, then violates the primary key at run time. A query that
    // is slow precisely BECAUSE it scanned for ages before failing must not
    // vanish from the log.
    const stmt = db.query('INSERT INTO conv (id, n) VALUES ($id, 0)')
    expect(() => stmt.run({ id: 'c1' })).toThrow()

    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('run')
    expect(stats.top(1)[0].count).toBe(1)
  })

  test('a reused statement is wrapped once and keeps accumulating', () => {
    const { db, stats } = instrument(1)
    const stmt = db.query('SELECT id FROM conv WHERE n = $n')
    for (let i = 0; i < 5; i++) stmt.all({ n: i })
    const top = stats.top(1)
    expect(top[0].count).toBe(5)
  })
})

describe('QueryStats', () => {
  test('ranks by total time, not by worst single call', () => {
    const stats = new QueryStats()
    stats.record('SELECT rare', 100)
    for (let i = 0; i < 50; i++) stats.record('SELECT hot', 10)

    const top = stats.top(2)
    expect(top[0].sql).toBe('SELECT hot')
    expect(top[0].totalMs).toBe(500)
    expect(top[0].count).toBe(50)
    expect(top[1].sql).toBe('SELECT rare')
  })

  test('collapses whitespace so one query is one bucket', () => {
    const stats = new QueryStats()
    stats.record('SELECT   a\n  FROM b', 5)
    stats.record('SELECT a FROM b', 5)
    expect(stats.top(5)).toHaveLength(1)
  })

  test('reset clears the window', () => {
    const stats = new QueryStats()
    stats.record('SELECT 1', 5)
    stats.reset()
    expect(stats.top(5)).toEqual([])
  })
})

describe('formatting', () => {
  test('normalizeSql flattens and clips', () => {
    expect(normalizeSql('SELECT\n  a,\n  b\nFROM t')).toBe('SELECT a, b FROM t')
    expect(normalizeSql('x'.repeat(300))).toHaveLength(203)
  })

  test('a slow query line carries duration, method, rows and sql', () => {
    const line = formatSlowQuery({ sql: 'SELECT * FROM conv', ms: 312.4, rows: 2367, method: 'all' })
    expect(line).toContain('312.4ms')
    expect(line).toContain('all')
    expect(line).toContain('rows=2367')
    expect(line).toContain('SELECT * FROM conv')
  })

  test('the summary says so explicitly when nothing was recorded', () => {
    expect(formatStatsSummary([])).toContain('nothing recorded')
  })
})
