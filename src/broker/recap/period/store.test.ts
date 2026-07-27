import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDriver } from '../../store/sqlite/driver'
import type { StoreDriver } from '../../store/types'
import { createPeriodRecapStore, type PeriodRecapStore } from './store'

describe('PeriodRecapStore', () => {
  let cacheDir: string
  let driver: StoreDriver
  let store: PeriodRecapStore

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'period-recap-test-'))
    driver = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    driver.init()
    store = createPeriodRecapStore(cacheDir)
  })

  afterEach(() => {
    driver.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  function makeRecap(overrides: Partial<Parameters<typeof store.insert>[0]> = {}) {
    return store.insert({
      id: 'recap_test_1',
      projectUri: 'claude://default/test',
      periodLabel: 'last_7',
      periodStart: 1_700_000_000_000,
      periodEnd: 1_700_604_800_000,
      timeZone: 'Europe/Stockholm',
      audience: 'human',
      signalsJson: JSON.stringify(['user_prompts', 'commits']),
      signalsHash: 'sha-test',
      createdAt: Date.now(),
      ...overrides,
    })
  }

  it('insert + get round-trips', () => {
    const inserted = makeRecap()
    expect(inserted.status).toBe('queued')
    expect(inserted.progress).toBe(0)
    const fetched = store.get('recap_test_1')
    expect(fetched).not.toBeNull()
    expect(fetched?.projectUri).toBe('claude://default/test')
    expect(fetched?.periodLabel).toBe('last_7')
  })

  it('list filters by projectUri', () => {
    makeRecap()
    makeRecap({ id: 'recap_other', projectUri: 'claude://default/other' })
    const onlyTest = store.list({ projectUri: 'claude://default/test' })
    expect(onlyTest.length).toBe(1)
    expect(onlyTest[0].id).toBe('recap_test_1')
  })

  it('list filters by status', () => {
    makeRecap()
    makeRecap({ id: 'recap_done' })
    store.update('recap_done', { status: 'done', completedAt: Date.now() })
    const done = store.list({ status: ['done'] })
    expect(done.map(r => r.id)).toEqual(['recap_done'])
  })

  it('update applies sparse patches', () => {
    makeRecap()
    store.update('recap_test_1', { status: 'rendering', progress: 55, phase: 'render/llm' })
    const after = store.get('recap_test_1')
    expect(after?.status).toBe('rendering')
    expect(after?.progress).toBe(55)
    expect(after?.phase).toBe('render/llm')
  })

  it('round-trips the resilience statuses (partial / interrupted) + filters by them', () => {
    makeRecap({ id: 'recap_partial' })
    makeRecap({ id: 'recap_interrupted' })
    store.update('recap_partial', { status: 'partial', error: '2 of 6 chunks failed', completedAt: Date.now() })
    store.update('recap_interrupted', { status: 'interrupted' })
    expect(store.get('recap_partial')?.status).toBe('partial')
    expect(store.get('recap_partial')?.error).toBe('2 of 6 chunks failed')
    expect(store.get('recap_interrupted')?.status).toBe('interrupted')
    expect(store.list({ status: ['partial'] }).map(r => r.id)).toEqual(['recap_partial'])
    expect(store.list({ status: ['interrupted'] }).map(r => r.id)).toEqual(['recap_interrupted'])
  })

  it('appendLog + getLogs preserves chronological order', () => {
    makeRecap()
    store.appendLog({ recapId: 'recap_test_1', timestamp: 100, level: 'info', phase: 'gather', message: 'one' })
    store.appendLog({
      recapId: 'recap_test_1',
      timestamp: 200,
      level: 'warn',
      phase: 'gather',
      message: 'two',
      data: { count: 7 },
    })
    const logs = store.getLogs('recap_test_1')
    expect(logs.length).toBe(2)
    expect(logs[0].message).toBe('one')
    expect(logs[1].message).toBe('two')
    expect(logs[1].data).toEqual({ count: 7 })
  })

  it('insertChunk + getChunks returns ordered chunks', () => {
    makeRecap()
    store.insertChunk({
      id: 'recapc_a',
      parentId: 'recap_test_1',
      chunkKind: 'day',
      chunkStart: 1_000,
      chunkEnd: 2_000,
      markdown: '# Day 1',
      inputChars: 100,
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.001,
      model: 'anthropic/claude-haiku-4-5',
      createdAt: Date.now(),
    })
    store.insertChunk({
      id: 'recapc_b',
      parentId: 'recap_test_1',
      chunkKind: 'day',
      chunkStart: 500,
      chunkEnd: 1_000,
      markdown: '# Day 0',
      inputChars: 80,
      inputTokens: 40,
      outputTokens: 20,
      costUsd: 0.0008,
      model: 'anthropic/claude-haiku-4-5',
      createdAt: Date.now(),
    })
    const chunks = store.getChunks('recap_test_1')
    expect(chunks.map(c => c.id)).toEqual(['recapc_b', 'recapc_a'])
  })

  it('setTags replaces existing tags atomically', () => {
    makeRecap()
    store.setTags('recap_test_1', [
      { recapId: 'recap_test_1', tag: 'sqlite', kind: 'keyword' },
      { recapId: 'recap_test_1', tag: 'ship-week', kind: 'hashtag' },
    ])
    expect(store.getTags('recap_test_1').length).toBe(2)
    store.setTags('recap_test_1', [{ recapId: 'recap_test_1', tag: 'fts5', kind: 'keyword' }])
    const tags = store.getTags('recap_test_1')
    expect(tags.length).toBe(1)
    expect(tags[0].tag).toBe('fts5')
  })

  it('upsertFts + searchFts find matching content', () => {
    makeRecap()
    store.upsertFts('recap_test_1', {
      projectUri: 'claude://default/test',
      title: 'SQLite Phase 4 ship',
      subtitle: 'WAL corruption discovered + fixed',
      keywords: 'sqlite wal btree',
      goals: 'fix wal',
      discoveries: 'docker cp corrupts WAL',
      sideEffects: '',
      body: 'docker cp on a live SQLite database corrupts the WAL.',
    })
    const hits = store.searchFts('WAL corruption')
    expect(hits.length).toBe(1)
    expect(hits[0].recapId).toBe('recap_test_1')
    expect(hits[0].snippet).toContain('<mark>')
  })

  it('findCacheHit returns recent done recap with matching signals', () => {
    makeRecap()
    store.update('recap_test_1', { status: 'done', completedAt: Date.now() - 1000 })
    const hit = store.findCacheHit({
      projectUri: 'claude://default/test',
      periodStart: 1_700_000_000_000,
      periodEnd: 1_700_604_800_000,
      signalsHash: 'sha-test',
      freshSinceMs: 5 * 60 * 1000,
    })
    expect(hit?.id).toBe('recap_test_1')
  })

  it('findCacheHit ignores stale completions', () => {
    makeRecap()
    store.update('recap_test_1', { status: 'done', completedAt: Date.now() - 10 * 60 * 1000 })
    const hit = store.findCacheHit({
      projectUri: 'claude://default/test',
      periodStart: 1_700_000_000_000,
      periodEnd: 1_700_604_800_000,
      signalsHash: 'sha-test',
      freshSinceMs: 5 * 60 * 1000,
    })
    expect(hit).toBeNull()
  })

  it('delete removes the row', () => {
    makeRecap()
    expect(store.delete('recap_test_1')).toBe(true)
    expect(store.get('recap_test_1')).toBeNull()
  })
})

describe('PeriodRecapStore map cache (cross-run extraction reuse)', () => {
  let cacheDir: string
  let driver: StoreDriver
  let store: PeriodRecapStore

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'period-recap-mapcache-'))
    driver = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    driver.init()
    store = createPeriodRecapStore(cacheDir)
  })

  afterEach(() => {
    driver.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  const meta = (kw: string) =>
    ({
      keywords: [kw],
      hashtags: [],
      goals: [],
      discoveries: [],
      side_effects: [],
      features: [],
      bugs: [],
      fixes: [],
      incidents: [],
      decisions: [],
      dead_ends: [],
      gotchas: [],
      frustrations: [],
      open_questions: [],
      stakeholders: [],
    }) as Parameters<typeof store.mapCachePut>[0]['metadata']

  it('round-trips an extraction by content key', () => {
    store.mapCachePut({ key: 'k1', conversationId: 'c1', metadata: meta('alpha'), model: 'm' })
    expect(store.mapCacheGetMany(['k1']).get('k1')?.keywords).toEqual(['alpha'])
  })

  it('returns nothing for unknown keys and tolerates an empty ask', () => {
    expect(store.mapCacheGetMany([]).size).toBe(0)
    expect(store.mapCacheGetMany(['nope']).size).toBe(0)
  })

  it('survives more keys than SQLite will bind at once', () => {
    // A month-long recap can ask about more conversations than the 999-variable
    // limit; the lookup chunks its IN(...) so this must not throw.
    const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`)
    store.mapCachePut({ key: 'k1200', conversationId: 'c', metadata: meta('deep'), model: 'm' })
    const found = store.mapCacheGetMany(keys)
    expect(found.get('k1200')?.keywords).toEqual(['deep'])
  })

  it('re-putting the same key does not duplicate or throw', () => {
    store.mapCachePut({ key: 'k1', conversationId: 'c1', metadata: meta('first'), model: 'm' })
    store.mapCachePut({ key: 'k1', conversationId: 'c1', metadata: meta('first'), model: 'm' })
    expect(store.mapCacheGetMany(['k1']).size).toBe(1)
  })

  it('prunes only entries unused past the cutoff', () => {
    store.mapCachePut({ key: 'k1', conversationId: 'c1', metadata: meta('alpha'), model: 'm' })
    expect(store.mapCachePrune(60_000)).toBe(0) // just written -- still hot
    expect(store.mapCachePrune(-1)).toBe(1) // cutoff in the future -- everything goes
    expect(store.mapCacheGetMany(['k1']).size).toBe(0)
  })
})
