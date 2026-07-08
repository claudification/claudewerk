import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRecapOrchestrator, type RecapOrchestrator, resetRecapOrchestratorForTests } from './recap-orchestrator'
import { createSqliteDriver } from './store/sqlite/driver'
import type { StoreDriver } from './store/types'

/** Minimal brokerStore stub -- reapStale never touches it. */
const fakeBrokerStore = new Proxy(
  {},
  {
    get() {
      throw new Error('brokerStore not under test')
    },
  },
) as unknown as StoreDriver

function insertInFlight(orch: RecapOrchestrator, id: string, createdAt: number, informId?: string): void {
  orch.store.insert({
    id,
    projectUri: 'claude://default/proj',
    periodLabel: 'last_7',
    periodStart: 0,
    periodEnd: 1,
    timeZone: 'UTC',
    audience: 'human',
    signalsJson: '[]',
    signalsHash: 'h',
    createdAt,
    ...(informId ? { informConversationId: informId } : {}),
  })
  orch.store.update(id, { status: 'rendering', progress: 42, startedAt: createdAt })
}

describe('reapStale', () => {
  let cacheDir: string
  let driver: StoreDriver
  let orch: RecapOrchestrator
  const broadcasts: Array<Record<string, unknown>> = []
  const informs: Array<{ conversationId: string; text: string }> = []

  beforeEach(() => {
    resetRecapOrchestratorForTests()
    cacheDir = mkdtempSync(join(tmpdir(), 'recap-orch-test-'))
    // The recaps tables live in the shared store.db -- the driver's init() runs
    // their migration; createPeriodRecapStore just opens the same file.
    driver = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    driver.init()
    broadcasts.length = 0
    informs.length = 0
    process.env.CLAUDWERK_RECAP_REAP_CEILING_MS = '1' // 1ms -> anything with age is stale
    orch = initRecapOrchestrator({
      cacheDir,
      brokerStore: fakeBrokerStore,
      broadcaster: { broadcast: m => broadcasts.push(m as Record<string, unknown>) },
      informConversation: (conversationId, msg) => informs.push({ conversationId, text: msg.text }),
    })
  })

  afterEach(() => {
    resetRecapOrchestratorForTests()
    delete process.env.CLAUDWERK_RECAP_REAP_CEILING_MS
    driver.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('force-fails a silent in-flight recap past the ceiling + broadcasts + informs', () => {
    insertInFlight(orch, 'recap_stuck', Date.now() - 60_000, 'conv_owner')
    const reaped = orch.reapStale()
    expect(reaped.map(r => r.id)).toEqual(['recap_stuck'])
    expect(orch.store.get('recap_stuck')?.status).toBe('failed')
    expect(orch.store.get('recap_stuck')?.error).toContain('reaped')
    expect(broadcasts.some(b => b.type === 'recap_progress' && b.status === 'failed')).toBe(true)
    expect(informs).toHaveLength(1)
    expect(informs[0].text).toContain('failed')
  })

  it('leaves a FRESH in-flight recap alone (recent activity)', () => {
    // Ceiling well above the row's age -> not stale.
    process.env.CLAUDWERK_RECAP_REAP_CEILING_MS = String(10 * 60_000)
    insertInFlight(orch, 'recap_live', Date.now() - 1000)
    expect(orch.reapStale()).toEqual([])
    expect(orch.store.get('recap_live')?.status).toBe('rendering')
  })

  it('never touches a terminal recap', () => {
    insertInFlight(orch, 'recap_done', Date.now() - 60_000)
    orch.store.update('recap_done', { status: 'done' })
    expect(orch.reapStale()).toEqual([])
    expect(orch.store.get('recap_done')?.status).toBe('done')
  })
})
