import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRecapOrchestrator, type RecapOrchestrator } from './recap-orchestrator'
import { createSqliteDriver } from './store/sqlite/driver'
import type { StoreDriver } from './store/types'

// Phase 6 boot sweep: orphaned in-flight recaps -> 'interrupted' (resumable),
// terminal recaps untouched, a structured message emitted per reclaim.
describe('boot sweep (sweepInterrupted)', () => {
  let cacheDir: string
  let brokerStore: StoreDriver
  let orch: RecapOrchestrator
  const broadcasts: Array<Record<string, unknown>> = []

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'recap-sweep-'))
    // Same dir for both: driver.init() creates the recaps schema in store.db,
    // which createPeriodRecapStore(cacheDir) then opens (the store-test pattern).
    brokerStore = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    brokerStore.init()
    broadcasts.length = 0
    orch = initRecapOrchestrator({
      cacheDir,
      brokerStore,
      broadcaster: { broadcast: m => broadcasts.push(m as Record<string, unknown>) },
    })
  })
  afterEach(() => {
    brokerStore.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  function insert(id: string, status: string) {
    orch.store.insert({
      id,
      projectUri: 'claude://default/p',
      periodLabel: 'last_7',
      periodStart: 1,
      periodEnd: 2,
      timeZone: 'UTC',
      audience: 'human',
      signalsJson: '["commits"]',
      signalsHash: 'h',
      createdAt: Date.now(),
    })
    orch.store.update(id, { status: status as any, progress: status === 'rendering' ? 45 : 0 })
  }

  it('reclaims queued/gathering/rendering -> interrupted, leaves terminal rows alone', () => {
    insert('r_rendering', 'rendering')
    insert('r_gathering', 'gathering')
    insert('r_queued', 'queued')
    insert('r_done', 'done')
    insert('r_failed', 'failed')

    const swept = orch.sweepInterrupted()

    expect(swept.map(s => s.id).sort()).toEqual(['r_gathering', 'r_queued', 'r_rendering'])
    expect(orch.store.get('r_rendering')?.status).toBe('interrupted')
    expect(orch.store.get('r_gathering')?.status).toBe('interrupted')
    expect(orch.store.get('r_queued')?.status).toBe('interrupted')
    // terminal rows untouched
    expect(orch.store.get('r_done')?.status).toBe('done')
    expect(orch.store.get('r_failed')?.status).toBe('failed')
    // a structured message per reclaim (EVERYTHING IS A MESSAGE covenant)
    expect(broadcasts.filter(b => b.status === 'interrupted').length).toBe(3)
    // prev status + progress are captured (LOG EVERYTHING covenant)
    expect(swept.find(s => s.id === 'r_rendering')).toMatchObject({ prevStatus: 'rendering', progress: 45 })
  })

  it('is a no-op when nothing is in flight', () => {
    insert('r_done', 'done')
    expect(orch.sweepInterrupted()).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })
})
