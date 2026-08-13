/**
 * The project summary page's query, against both drivers.
 *
 * Two things have to hold. The window semantics must be IDENTICAL in SQLite and
 * memory -- a rule implemented twice is a rule that drifts. And the SQLite query
 * must actually use the composite index: this runs against a table where a
 * single project holds 800+ ended rows, so a plan that falls back to a scan plus
 * a sort is the difference between the feature working and it being the new
 * reason the panel is slow.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createMemoryDriver } from '../memory/driver'
import { createSqliteConversationStore } from '../sqlite/conversations'
import { createSchema } from '../sqlite/schema'
import type { ConversationStore } from '../types'

const PROJECT = 'claude://default/Users/jonas/projects/remote-claude'
const OTHER = 'claude://default/Users/jonas/projects/portal2'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

interface Seed {
  id: string
  scope: string
  status: string
  lastActivity: number
}

function seedRows(): Seed[] {
  const rows: Seed[] = []
  // 80 ended in this project, one per day going back -- so only 5 are inside
  // the default 5-day window and the count half of the rule cannot carry it.
  for (let i = 0; i < 80; i++) {
    rows.push({ id: `old${i}`, scope: PROJECT, status: 'ended', lastActivity: NOW - i * DAY })
  }
  // A different project must never leak in.
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `other${i}`, scope: OTHER, status: 'ended', lastActivity: NOW - i * 1000 })
  }
  rows.push({ id: 'live', scope: PROJECT, status: 'idle', lastActivity: NOW })
  return rows
}

/**
 * Seed through create-then-update rather than passing `status` to create.
 *
 * The two drivers disagree there: SQLite persists `input.status`, while the
 * memory driver hardcodes `'active'` and ignores it. Both honour `update`, and
 * update is the truthful lifecycle anyway (a conversation starts active and
 * becomes ended), so seeding this way tests the window rule rather than that
 * inconsistency.
 */
function seed(store: ConversationStore): ConversationStore {
  for (const r of seedRows()) {
    store.create({ id: r.id, scope: r.scope, agentType: 'claude', createdAt: r.lastActivity })
    store.update(r.id, { status: r.status, lastActivity: r.lastActivity })
  }
  return store
}

function sqliteStore(): ConversationStore {
  const db = new Database(':memory:', { strict: true })
  createSchema(db)
  return seed(createSqliteConversationStore(db))
}

function memoryStore(): ConversationStore {
  return seed(createMemoryDriver().conversations)
}

const drivers: Array<[string, () => ConversationStore]> = [
  ['sqlite', sqliteStore],
  ['memory', memoryStore],
]

for (const [name, make] of drivers) {
  describe(`listRecentByScope (${name})`, () => {
    test('returns the minimum count when the age window is nearly empty', () => {
      const rows = make().listRecentByScope(PROJECT, { status: ['ended'], now: NOW })
      // Only 5 rows are within 5 days, so the floor of 50 governs.
      expect(rows).toHaveLength(50)
    })

    test('newest first', () => {
      const rows = make().listRecentByScope(PROJECT, { status: ['ended'], now: NOW })
      expect(rows[0].id).toBe('old0')
      expect(rows[1].id).toBe('old1')
    })

    test('never leaks another project', () => {
      const rows = make().listRecentByScope(PROJECT, { status: ['ended'], now: NOW })
      expect(rows.every(r => r.scope === PROJECT)).toBe(true)
    })

    test('the status filter excludes live conversations', () => {
      const rows = make().listRecentByScope(PROJECT, { status: ['ended'], now: NOW })
      expect(rows.some(r => r.id === 'live')).toBe(false)
    })

    test('a wide age window beats the count floor', () => {
      // 100 days back sweeps in all 80 ended rows -- more than the floor of 50.
      const rows = make().listRecentByScope(PROJECT, {
        status: ['ended'],
        withinMs: 100 * DAY,
        now: NOW,
      })
      expect(rows).toHaveLength(80)
    })

    test('the hard cap is obeyed even when the age window is wide', () => {
      const rows = make().listRecentByScope(PROJECT, {
        status: ['ended'],
        withinMs: 100 * DAY,
        hardCap: 12,
        now: NOW,
      })
      expect(rows).toHaveLength(12)
    })
  })

  describe(`countByScopeAndStatus (${name})`, () => {
    test('counts ended per project and ignores other statuses', () => {
      const counts = make().countByScopeAndStatus(['ended'])
      const byScope = Object.fromEntries(counts.map(c => [c.scope, c.count]))
      expect(byScope[PROJECT]).toBe(80)
      expect(byScope[OTHER]).toBe(10)
    })

    test('an empty status list asks nothing and returns nothing', () => {
      expect(make().countByScopeAndStatus([])).toEqual([])
    })
  })
}

describe('sqlite query plan', () => {
  test('the scoped recent query uses the composite index instead of scanning', () => {
    const db = new Database(':memory:', { strict: true })
    createSchema(db)

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM conversations
          WHERE scope = $scope AND status IN ($s0)
          ORDER BY last_activity DESC
          LIMIT 50`,
      )
      .all({ scope: PROJECT, s0: 'ended' }) as Array<{ detail: string }>

    const detail = plan.map(p => p.detail).join(' | ')
    expect(detail).toContain('idx_conversations_scope_status_activity')
    // A B-TREE FOR ORDER BY means SQLite materialised and sorted the survivors,
    // which is exactly what the trailing index column exists to prevent.
    expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY')
  })
})
