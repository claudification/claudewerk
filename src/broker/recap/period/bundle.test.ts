import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRecapBundleWriter,
  RECAP_PIPELINE_VERSION,
  type RecapBundleManifest,
  type RecapBundleWriter,
} from './bundle'

describe('RecapBundleWriter', () => {
  let cacheDir: string
  let bundle: RecapBundleWriter
  const RECAP_ID = 'recap_bundletest1'

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'recap-bundle-test-'))
    bundle = createRecapBundleWriter(cacheDir)
  })

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true })
  })

  function readManifest(recapId = RECAP_ID): RecapBundleManifest {
    return JSON.parse(readFileSync(join(bundle.dir(recapId), 'manifest.json'), 'utf8')) as RecapBundleManifest
  }

  function begin(recapId = RECAP_ID): void {
    bundle.begin(recapId, {
      projectUri: 'claude://default/test',
      period: { label: 'last_7', start: 1000, end: 2000, human: 'last 7 days', isoRange: '...' },
      audience: 'human',
      batchId: 'batch_xyz',
      createdAt: 1234,
      createdBy: 'tester',
    })
  }

  it('begin() creates the dir + an initial manifest carrying the pipeline version', () => {
    begin()
    expect(existsSync(bundle.dir(RECAP_ID))).toBe(true)
    const m = readManifest()
    expect(m.pipelineVersion).toBe(RECAP_PIPELINE_VERSION)
    expect(m.recapId).toBe(RECAP_ID)
    expect(m.batchId).toBe('batch_xyz') // batchId lives IN the manifest, not the folder name
    expect(m.projectUri).toBe('claude://default/test')
    expect(m.status).toBe('gathering')
    expect(m.artifacts).toEqual({ merged: false, finalMarkdown: false, mapChunks: 0 })
    expect(m.createdBy).toBe('tester')
  })

  it('the bundle folder is keyed by recapId (batchId is metadata only)', () => {
    begin()
    expect(bundle.dir(RECAP_ID).endsWith(join('recaps', RECAP_ID))).toBe(true)
  })

  it('records assembled prompts + raw responses, paired by seq', () => {
    begin()
    const prompt = { stage: 'oneshot', model: 'anthropic/claude-opus-4.8', system: 'sys', user: 'usr' }
    const seq = bundle.recordCallPrompt(RECAP_ID, prompt)
    expect(seq).toBe(1)
    bundle.recordCallResponse(RECAP_ID, seq, prompt, { ok: true, ms: 42, content: 'hello body', raw: { usage: {} } })
    const base = join(bundle.dir(RECAP_ID), 'calls', '001-oneshot')
    expect(JSON.parse(readFileSync(`${base}.prompt.json`, 'utf8'))).toMatchObject({
      model: 'anthropic/claude-opus-4.8',
      system: 'sys',
    })
    expect(readFileSync(`${base}.response.txt`, 'utf8')).toBe('hello body')
    expect(existsSync(`${base}.response.raw.json`)).toBe(true)
  })

  it('NEVER writes an apiKey/secret to a prompt file (scrub-by-construction)', () => {
    begin()
    // The prompt type has no apiKey field; even a malicious extra key on the object
    // is the caller's bug, but the canonical orchestrator path never passes one.
    const prompt = { stage: 'map', chunkIndex: 0, model: 'm', system: 'sys', user: 'usr' }
    const seq = bundle.recordCallPrompt(RECAP_ID, prompt)
    bundle.recordCallResponse(RECAP_ID, seq, prompt, { ok: true, ms: 1, content: 'x', raw: {} })
    const text = readFileSync(join(bundle.dir(RECAP_ID), 'calls', '001-map-c0.prompt.json'), 'utf8')
    expect(text).not.toContain('Authorization')
    expect(text).not.toContain('Bearer')
    expect(text).not.toContain('apiKey')
  })

  it('records the FAILURE (incl. truncated/erroring calls), not just successes', () => {
    begin()
    const prompt = { stage: 'reduce', model: 'm', system: 's', user: 'u' }
    const seq = bundle.recordCallPrompt(RECAP_ID, prompt)
    bundle.recordCallResponse(RECAP_ID, seq, prompt, { ok: false, ms: 99, error: 'OpenRouter 400' })
    const errFile = join(bundle.dir(RECAP_ID), 'calls', '001-reduce.error.json')
    expect(existsSync(errFile)).toBe(true)
    expect(JSON.parse(readFileSync(errFile, 'utf8'))).toMatchObject({ ok: false, error: 'OpenRouter 400' })
  })

  it('appends progress lines as NDJSON (incremental trail)', () => {
    begin()
    bundle.appendProgress(RECAP_ID, { kind: 'status', status: 'gathering' })
    bundle.appendProgress(RECAP_ID, { kind: 'progress', progress: 35, phase: 'gather/done' })
    const lines = readFileSync(join(bundle.dir(RECAP_ID), 'progress.ndjson'), 'utf8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'status' })
    expect(JSON.parse(lines[1])).toMatchObject({ progress: 35 })
  })

  it('records map-chunk JSON, merged JSON, final markdown + flips manifest.artifacts', () => {
    begin()
    bundle.recordMapParsed(RECAP_ID, 0, { features: [{ title: 'a' }] })
    bundle.recordMapParsed(RECAP_ID, 1, { features: [] })
    bundle.recordMerged(RECAP_ID, { features: [{ title: 'a' }], bugs: [] })
    bundle.recordFinalMarkdown(RECAP_ID, '# Recap\nbody')
    expect(existsSync(join(bundle.dir(RECAP_ID), 'chunks', 'map-0.parsed.json'))).toBe(true)
    expect(existsSync(join(bundle.dir(RECAP_ID), 'chunks', 'map-1.parsed.json'))).toBe(true)
    expect(existsSync(join(bundle.dir(RECAP_ID), 'merged.json'))).toBe(true)
    expect(readFileSync(join(bundle.dir(RECAP_ID), 'final.md'), 'utf8')).toBe('# Recap\nbody')
    const m = readManifest()
    expect(m.artifacts).toEqual({ merged: true, finalMarkdown: true, mapChunks: 2 })
  })

  it('updateManifest merges patches (mode/models/recipe/status/cost/timing)', () => {
    begin()
    bundle.updateManifest(RECAP_ID, { startedAt: 5000 })
    bundle.updateManifest(RECAP_ID, {
      mode: 'chunked',
      models: { map: 'sonnet', reduce: 'opus' },
      chunkCount: 3,
      recipe: { mode: 'chunked', chunkSize: 150000 },
    })
    bundle.updateManifest(RECAP_ID, {
      status: 'done',
      completedAt: 9000,
      cost: {
        totalCostUsd: 1.23,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        callCount: 4,
        models: ['sonnet', 'opus'],
        byStage: {},
      },
    })
    const m = readManifest()
    expect(m.mode).toBe('chunked')
    expect(m.models).toEqual({ map: 'sonnet', reduce: 'opus' })
    expect(m.chunkCount).toBe(3)
    expect(m.recipe).toMatchObject({ chunkSize: 150000 })
    expect(m.status).toBe('done')
    expect(m.timing.startedAt).toBe(5000)
    expect(m.timing.completedAt).toBe(9000)
    expect(m.cost?.totalCostUsd).toBe(1.23)
  })

  it('is best-effort: methods on a recap that never called begin() do not throw', () => {
    expect(() => bundle.appendProgress('recap_never', { x: 1 })).not.toThrow()
    expect(() => bundle.recordMerged('recap_never', {})).not.toThrow()
    expect(() => bundle.recordFinalMarkdown('recap_never', 'md')).not.toThrow()
    // updateManifest on a missing bundle is a no-op (no manifest to patch)
    expect(() => bundle.updateManifest('recap_never', { status: 'failed' })).not.toThrow()
    expect(existsSync(bundle.dir('recap_never'))).toBe(false)
  })

  it('isolates per-recap call counters (parallel recaps do not share seq)', () => {
    begin('recap_a')
    begin('recap_b')
    expect(bundle.recordCallPrompt('recap_a', { stage: 'map', model: 'm' })).toBe(1)
    expect(bundle.recordCallPrompt('recap_b', { stage: 'map', model: 'm' })).toBe(1)
    expect(bundle.recordCallPrompt('recap_a', { stage: 'reduce', model: 'm' })).toBe(2)
  })

  // --- Pillar C++ reads ---

  it('reads back manifest / merged / final-response / stage prompt', () => {
    begin()
    bundle.recordMerged(RECAP_ID, { features: [{ title: 'x' }] })
    bundle.recordFinalResponse(RECAP_ID, '---\nsubtitle: s\n---\nbody')
    const seq = bundle.recordCallPrompt(RECAP_ID, { stage: 'oneshot', model: 'm', system: 'SYS', user: 'USR' })
    bundle.recordCallResponse(RECAP_ID, seq, { stage: 'oneshot', model: 'm' }, { ok: true, ms: 1, content: 'c' })
    expect(bundle.readManifest(RECAP_ID)?.recapId).toBe(RECAP_ID)
    expect(bundle.readMerged<{ features: unknown[] }>(RECAP_ID)?.features).toHaveLength(1)
    expect(bundle.readFinalResponse(RECAP_ID)).toContain('subtitle: s')
    expect(bundle.readStagePrompt(RECAP_ID, 'oneshot')).toEqual({ system: 'SYS', user: 'USR' })
  })

  it('readers return null when nothing was recorded', () => {
    begin()
    expect(bundle.readMerged('recap_missing')).toBeNull()
    expect(bundle.readFinalResponse(RECAP_ID)).toBeNull()
    expect(bundle.readStagePrompt(RECAP_ID, 'reduce')).toBeNull()
    expect(bundle.readManifest('recap_missing')).toBeNull()
  })

  it('forkUpstream copies the source bundle into a new recapId dir', () => {
    begin('recap_src')
    bundle.recordMerged('recap_src', { features: [{ title: 'keep' }] })
    bundle.recordMapParsed('recap_src', 0, { features: [] })
    bundle.forkUpstream('recap_src', 'recap_fork')
    // upstream artifacts are present on the fork...
    expect(bundle.readMerged<{ features: { title: string }[] }>('recap_fork')?.features[0].title).toBe('keep')
    expect(existsSync(join(bundle.dir('recap_fork'), 'chunks', 'map-0.parsed.json'))).toBe(true)
    // ...and the fork has its own call counter (starts at 1)
    expect(bundle.recordCallPrompt('recap_fork', { stage: 'reduce', model: 'm' })).toBe(1)
  })
})
