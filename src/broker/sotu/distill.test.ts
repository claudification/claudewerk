import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChronicle } from './chronicle'
import type { SotuProjectConfig } from './config'
import { recordContribution } from './contribute'
import { applyDecay, integratedBranches } from './distill/decay'
import type { ChatFn } from './distill/llm'
import { type DistillDeps, runDistill } from './distill/run'
import { initSotuStore, projectSlug } from './index'
import { distillDir } from './paths'
import { recordSpend } from './spend'
import { readState } from './state'
import { SOTU_TUNING_DEFAULTS } from './tuning'
import type { Chronicle, GitFabric } from './types'

const PROJECT = '/Users/jonas/projects/remote-claude'
const NOW = 1_000_000
const ENABLED: SotuProjectConfig = { enabled: true, budget: {}, params: SOTU_TUNING_DEFAULTS }
let dir: string
let slug: string

const CHRON = JSON.stringify({
  now: [{ convId: 'c1', detail: 'working on auth', ts: 1 }],
  justDone: [],
  narrative: 'auth in progress',
})

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.02,
  costSource: 'litellm' as const,
}

/** A stub chat fn returning a fixed body; records every request. */
function stubChat(body = CHRON): { fn: ChatFn; calls: number } {
  const state = { fn: (() => {}) as unknown as ChatFn, calls: 0 }
  state.fn = async () => {
    state.calls++
    return { content: body, usage: USAGE }
  }
  return state
}

function deps(chat: ChatFn, broadcasts: Record<string, unknown>[]): DistillDeps {
  return { chat, broadcast: m => broadcasts.push(m), now: () => NOW }
}

const fabric = (integration: GitFabric['branches'][number]['integration']): GitFabric => ({
  branches: [
    { branch: 'feat', aheadOrigin: 1, behindOrigin: 0, aheadLocal: 1, behindLocal: 0, integration, alerts: [] },
  ],
  scannedAt: 1,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-distill-'))
  initSotuStore(dir)
  slug = projectSlug(PROJECT)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('scribe fold: writes chronicle + bundle + ledger, records spend, broadcasts, resets counters', async () => {
  recordContribution(slug, { kind: 'turn_digest', convId: 'c1', ts: 10, intent: 'auth' }, PROJECT)
  const chat = stubChat()
  const broadcasts: Record<string, unknown>[] = []
  const out = await runDistill(deps(chat.fn, broadcasts), { slug, project: PROJECT, config: ENABLED })

  expect(out).toMatchObject({ status: 'distilled', mode: 'scribe', folded: 1 })
  expect(chat.calls).toBe(1)
  const chron = readChronicle(slug)
  expect(chron.narrative).toBe('auth in progress')
  expect(chron.now).toHaveLength(1)
  const st = readState(slug)
  expect(st.pendingContribs).toBe(0)
  expect(st.lastDistillAt).toBe(NOW)
  expect(st.genAt).toBe(NOW)
  expect(broadcasts).toHaveLength(1)
  expect(broadcasts[0]).toMatchObject({ type: 'sotu_updated', project: PROJECT, mode: 'scribe' })
  expect((broadcasts[0] as { costUsd: number }).costUsd).toBeCloseTo(0.02)
  // bundle on disk (recap C+)
  const bundle = distillDir(slug, NOW)
  expect(existsSync(join(bundle, 'manifest.json'))).toBe(true)
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({ mode: 'scribe', pipelineVersion: 1 })
  expect(manifest.cost.totalCostUsd).toBeCloseTo(0.02)
})

test('reconcile pass: two LLM calls, attaches the latest git fabric to the chronicle', async () => {
  recordContribution(slug, { kind: 'git_scan', convId: '', ts: 11, git: fabric('integrated') }, PROJECT)
  const chat = stubChat()
  const broadcasts: Record<string, unknown>[] = []
  const out = await runDistill(deps(chat.fn, broadcasts), {
    slug,
    project: PROJECT,
    config: ENABLED,
    forceReconcile: true,
  })
  expect(out).toMatchObject({ status: 'distilled', mode: 'reconcile' })
  expect(chat.calls).toBe(2) // scribe + reconcile
  expect(readChronicle(slug).git).toEqual(fabric('integrated'))
  expect(broadcasts[0]).toMatchObject({ type: 'sotu_updated', mode: 'reconcile' })
})

test('disabled project: floor only, NO LLM ever', async () => {
  recordContribution(slug, { kind: 'turn_digest', convId: 'c1', ts: 10 }, PROJECT)
  const chat = stubChat()
  const out = await runDistill(deps(chat.fn, []), {
    slug,
    project: PROJECT,
    config: { enabled: false, budget: {}, params: SOTU_TUNING_DEFAULTS },
  })
  expect(out.status).toBe('disabled')
  expect(chat.calls).toBe(0)
  expect(readChronicle(slug).narrative).toBe('')
})

test('budget gate: over cap -> skip the paid distill, emit sotu_budget_exhausted, keep floor', async () => {
  recordContribution(slug, { kind: 'turn_digest', convId: 'c1', ts: 10 }, PROJECT)
  recordSpend(slug, 1.0, NOW) // already spent the daily cap
  const chat = stubChat()
  const broadcasts: Record<string, unknown>[] = []
  const out = await runDistill(deps(chat.fn, broadcasts), {
    slug,
    project: PROJECT,
    config: { enabled: true, budget: { dailyUsd: 1 }, params: SOTU_TUNING_DEFAULTS },
  })
  expect(out.status).toBe('budget')
  expect(chat.calls).toBe(0)
  expect(broadcasts).toHaveLength(1)
  expect(broadcasts[0]).toMatchObject({
    type: 'sotu_budget_exhausted',
    project: PROJECT,
    budget: { dailyUsd: 1 },
  })
})

test('no new contributions + no force -> a no-op refresh, no spend', async () => {
  const chat = stubChat()
  const out = await runDistill(deps(chat.fn, []), { slug, project: PROJECT, config: ENABLED })
  expect(out.status).toBe('noop')
  expect(chat.calls).toBe(0)
  expect(readState(slug).genAt).toBe(NOW)
})

test('parse failure keeps the PRIOR chronicle but still records the cost it burned', async () => {
  recordContribution(slug, { kind: 'turn_digest', convId: 'c1', ts: 10 }, PROJECT)
  const chat = stubChat('this is not json at all')
  const broadcasts: Record<string, unknown>[] = []
  const out = await runDistill(deps(chat.fn, broadcasts), { slug, project: PROJECT, config: ENABLED })
  expect(out.status).toBe('error')
  expect(out.costUsd).toBeCloseTo(0.02) // chat succeeded, parse failed -> cost still counts
  expect(readChronicle(slug).narrative).toBe('') // prior chronicle untouched
  // still broadcasts an update + resets counters (the fold "happened", just empty)
  expect(broadcasts[0]).toMatchObject({ type: 'sotu_updated' })
  expect(readState(slug).pendingContribs).toBe(0)
})

// ─── decay (pure) ───────────────────────────────────────────────────

test('applyDecay prunes withered justDone past the cutoff + attaches git', () => {
  const chron: Chronicle = {
    now: [],
    justDone: [
      { convId: 'old', detail: 'ancient', ts: NOW - 100 * 60 * 60_000 },
      { convId: 'fresh', detail: 'recent', ts: NOW - 60_000 },
    ],
    narrative: 'x',
    pipelineVersion: 1,
    generatedAt: NOW,
  }
  const decayed = applyDecay(chron, fabric('integrated'), { now: NOW })
  expect(decayed.justDone.map(e => e.convId)).toEqual(['fresh'])
  expect(decayed.git).toEqual(fabric('integrated'))
})

test('integratedBranches lists only fully-absorbed branches', () => {
  const git: GitFabric = {
    branches: [
      {
        branch: 'a',
        aheadOrigin: 0,
        behindOrigin: 0,
        aheadLocal: 0,
        behindLocal: 0,
        integration: 'integrated',
        alerts: [],
      },
      {
        branch: 'b',
        aheadOrigin: 2,
        behindOrigin: 1,
        aheadLocal: 2,
        behindLocal: 1,
        integration: 'conflicts',
        alerts: [],
      },
    ],
    scannedAt: 1,
  }
  expect(integratedBranches(git)).toEqual(['a'])
  expect(integratedBranches(undefined)).toEqual([])
})
