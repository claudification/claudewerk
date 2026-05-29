import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDriver } from '../../store/sqlite/driver'
import type { StoreDriver } from '../../store/types'
import { createRecapBundleWriter, type RecapBundleWriter } from './bundle'
import type { OrchestratorDeps } from './orchestrator'
import { regenerateRecap } from './orchestrator'
import { createPeriodRecapStore, type PeriodRecapStore } from './store'

const VALID_RESPONSE = `---\nsubtitle: regenerated\nkeywords: [alpha]\n---\nThe body.`

describe('regenerateRecap (Pillar C++)', () => {
  let cacheDir: string
  let driver: StoreDriver
  let store: PeriodRecapStore
  let bundle: RecapBundleWriter
  let deps: OrchestratorDeps
  const SRC = 'recap_source01'

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'recap-regen-test-'))
    driver = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    driver.init()
    store = createPeriodRecapStore(cacheDir)
    bundle = createRecapBundleWriter(cacheDir)
    deps = { store, brokerStore: driver, broadcaster: { broadcast: () => {} }, bundle }
  })

  afterEach(() => {
    driver.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  function seedSource(opts: { withFinalResponse?: boolean; withMerged?: boolean } = {}): void {
    store.insert({
      id: SRC,
      projectUri: 'claude://default/test',
      periodLabel: 'last_7',
      periodStart: 1000,
      periodEnd: 2000,
      timeZone: 'UTC',
      audience: 'human',
      signalsJson: '[]',
      signalsHash: 'hash',
      createdAt: 1,
    })
    store.update(SRC, { status: 'done', title: 'Source recap', markdown: '# old', model: 'anthropic/claude-opus-4.8' })
    bundle.begin(SRC, {
      projectUri: 'claude://default/test',
      period: { label: 'last_7', start: 1000, end: 2000, human: 'last 7 days', isoRange: '2026-01-01..2026-01-07' },
      audience: 'human',
      createdAt: 1,
    })
    bundle.updateManifest(SRC, { status: 'done', mode: 'oneshot', models: { oneshot: 'anthropic/claude-opus-4.8' } })
    if (opts.withMerged) bundle.recordMerged(SRC, { features: [{ title: 'kept' }] })
    if (opts.withFinalResponse) bundle.recordFinalResponse(SRC, VALID_RESPONSE)
  }

  it('throws when the source recap does not exist', () => {
    expect(() => regenerateRecap(deps, { recapId: 'nope', from: 'render' })).toThrow(/not found/)
  })

  it('throws when the recap has no on-disk bundle', () => {
    store.insert({
      id: 'recap_nobundle',
      projectUri: 'p',
      periodLabel: 'last_7',
      periodStart: 1,
      periodEnd: 2,
      timeZone: 'UTC',
      audience: 'human',
      signalsJson: '[]',
      signalsHash: 'h',
      createdAt: 1,
    })
    expect(() => regenerateRecap(deps, { recapId: 'recap_nobundle', from: 'render' })).toThrow(/no run-artifact bundle/)
  })

  it('REFUSES on pipeline version mismatch (the non-negotiable version gate)', () => {
    seedSource({ withFinalResponse: true })
    // Corrupt the recorded pipeline version to simulate an incompatible bundle.
    const manifestPath = join(bundle.dir(SRC), 'manifest.json')
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    m.pipelineVersion = 999
    writeFileSync(manifestPath, JSON.stringify(m))
    expect(() => regenerateRecap(deps, { recapId: SRC, from: 'render' })).toThrow(/pipeline version mismatch/)
  })

  it('throws on synthesize when neither merged JSON nor oneshot prompt exists', () => {
    seedSource({ withFinalResponse: true }) // no merged, no oneshot prompt
    expect(() => regenerateRecap(deps, { recapId: SRC, from: 'synthesize' })).toThrow(
      /no merged JSON or oneshot prompt/,
    )
  })

  it('throws on render when there is no saved final response', () => {
    seedSource({ withFinalResponse: false })
    expect(() => regenerateRecap(deps, { recapId: SRC, from: 'render' })).toThrow(/no saved final response/)
  })

  it('fork render: returns a NEW recapId, preserves the source, finishes with re-rendered markdown (zero LLM)', async () => {
    seedSource({ withFinalResponse: true })
    const result = regenerateRecap(deps, { recapId: SRC, from: 'render', mode: 'fork' })
    expect(result.recapId).not.toBe(SRC)
    expect(result.sourceRecapId).toBe(SRC)
    expect(result.mode).toBe('fork')
    // background run completes without any LLM call (render path is pure re-parse)
    await waitForStatus(store, result.recapId, 'done')
    const row = store.get(result.recapId)
    expect(row?.status).toBe('done')
    expect(row?.markdown).toContain('The body.')
    expect(row?.subtitle).toBe('regenerated')
    expect(row?.llmCostUsd).toBe(0) // zero LLM cost on a render resume
    // source is untouched (fork never destroys a paid artifact)
    expect(store.get(SRC)?.markdown).toBe('# old')
    // the fork's manifest records its provenance
    expect(bundle.readManifest(result.recapId)?.regenerate).toMatchObject({ from: 'render', sourceRecapId: SRC })
  })

  it('in-place render: rewrites the SAME recap row', async () => {
    seedSource({ withFinalResponse: true })
    const result = regenerateRecap(deps, { recapId: SRC, from: 'render', mode: 'in-place' })
    expect(result.recapId).toBe(SRC)
    await waitForStatus(store, SRC, 'done')
    expect(store.get(SRC)?.markdown).toContain('The body.')
  })
})

async function waitForStatus(store: PeriodRecapStore, recapId: string, status: string, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (store.get(recapId)?.status === status) return
    await new Promise(r => setImmediate(r))
  }
  throw new Error(`recap ${recapId} did not reach status=${status} (last=${store.get(recapId)?.status})`)
}
