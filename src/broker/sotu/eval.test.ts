import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SotuProjectConfig } from './config'
import { recordContribution } from './contribute'
import type { ChatFn } from './distill/llm'
import { runDistill } from './distill/run'
import { buildRecipe, readDistillEvals } from './eval'
import { initSotuStore, projectSlug } from './index'
import { SOTU_TUNING_DEFAULTS } from './tuning'

const PROJECT = '/Users/jonas/projects/remote-claude'
const NOW = 1_000_000
const CFG: SotuProjectConfig = {
  enabled: true,
  budget: { dailyUsd: 5 },
  stakes: 'main-income',
  params: { ...SOTU_TUNING_DEFAULTS, scribeModel: 'x/cheap' },
}
let dir: string
let slug: string

const CHRON = JSON.stringify({
  now: [{ convId: 'c1', detail: 'auth', ts: 1 }],
  justDone: [],
  narrative: 'auth in progress',
})

function stubChat(): ChatFn {
  return async () => ({
    content: CHRON,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.02,
      costSource: 'litellm' as const,
    },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-eval-'))
  initSotuStore(dir)
  slug = projectSlug(PROJECT)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// ─── buildRecipe ────────────────────────────────────────────────────

test('buildRecipe: flat resolved tuning + budget/stakes/mode context', () => {
  const r = buildRecipe(CFG, 'scribe')
  expect(r).toMatchObject({
    mode: 'scribe',
    stakes: 'main-income',
    budgetDailyUsd: 5,
    scribeModel: 'x/cheap',
    reconcileModel: SOTU_TUNING_DEFAULTS.reconcileModel,
    pipelineVersion: 1,
  })
  expect(r.budgetMonthlyUsd).toBeUndefined() // unset cap is omitted, not 0
})

// ─── readDistillEvals (recipe + cost + grounding round-trip) ────────

test('readDistillEvals: a distill records recipe + cost + grounding, read back newest-first', async () => {
  recordContribution(slug, { kind: 'turn_digest', convId: 'c1', ts: 10, intent: 'auth' }, PROJECT)
  await runDistill({ chat: stubChat(), broadcast: () => {}, now: () => NOW }, { slug, project: PROJECT, config: CFG })

  const evals = readDistillEvals(slug)
  expect(evals).toHaveLength(1)
  const e = evals[0]
  if (!e) throw new Error('no eval')
  expect(e.ts).toBe(NOW)
  expect(e.mode).toBe('scribe')
  expect(e.costUsd).toBeCloseTo(0.02)
  expect(e.folded).toBe(1)
  expect(e.recipe.scribeModel).toBe('x/cheap')
  expect(e.recipe.stakes).toBe('main-income')
  // grounding: the chronicle cites c1, which IS in the folded queue -> perfectly grounded
  expect(e.grounding).toMatchObject({ precision: 1, unknownCited: 0, citedConvs: 1, knownConvs: 1 })
})

test('readDistillEvals: empty for a project with no distills', () => {
  expect(readDistillEvals(slug)).toEqual([])
})

test('readDistillEvals: a parse-failed distill still records its recipe (no grounding)', async () => {
  recordContribution(slug, { kind: 'turn_digest', convId: 'c1', ts: 10, intent: 'x' }, PROJECT)
  const badChat: ChatFn = async () => ({
    content: 'not json',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      costSource: 'litellm' as const,
    },
  })
  await runDistill({ chat: badChat, broadcast: () => {}, now: () => NOW }, { slug, project: PROJECT, config: CFG })
  const evals = readDistillEvals(slug)
  expect(evals).toHaveLength(1)
  expect(evals[0]?.error).toBeDefined()
  expect(evals[0]?.recipe.mode).toBe('scribe')
  expect(evals[0]?.grounding).toBeUndefined()
})
