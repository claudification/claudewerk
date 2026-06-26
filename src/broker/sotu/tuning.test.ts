import { expect, test } from 'bun:test'
import { resolveBudget, resolveTuning, SOTU_TUNING_DEFAULTS, STAKES_BUDGET_DEFAULTS } from './tuning'

// ─── resolveTuning ──────────────────────────────────────────────────

test('resolveTuning: no overrides -> a copy of the defaults', () => {
  const t = resolveTuning()
  expect(t).toEqual(SOTU_TUNING_DEFAULTS)
  expect(t).not.toBe(SOTU_TUNING_DEFAULTS) // a copy, not the singleton
})

test('resolveTuning: folds in a well-formed subset, leaves the rest at default', () => {
  const t = resolveTuning({ scribeModel: 'x/y', burstThreshold: 3 })
  expect(t.scribeModel).toBe('x/y')
  expect(t.burstThreshold).toBe(3)
  expect(t.reconcileModel).toBe(SOTU_TUNING_DEFAULTS.reconcileModel)
  expect(t.minIntervalMs).toBe(SOTU_TUNING_DEFAULTS.minIntervalMs)
})

test('resolveTuning: rejects garbage (NaN / non-positive / blank model) -> default', () => {
  const t = resolveTuning({
    burstThreshold: Number.NaN,
    minIntervalMs: -1,
    quietSettleMs: 0,
    scribeModel: '   ',
  })
  expect(t.burstThreshold).toBe(SOTU_TUNING_DEFAULTS.burstThreshold)
  expect(t.minIntervalMs).toBe(SOTU_TUNING_DEFAULTS.minIntervalMs)
  expect(t.quietSettleMs).toBe(SOTU_TUNING_DEFAULTS.quietSettleMs)
  expect(t.scribeModel).toBe(SOTU_TUNING_DEFAULTS.scribeModel)
})

test('resolveTuning: trims a model override', () => {
  expect(resolveTuning({ reconcileModel: '  a/b  ' }).reconcileModel).toBe('a/b')
})

// ─── resolveBudget (OPEN ITEM #5) ───────────────────────────────────

test('resolveBudget: no stakes + no caps -> unbounded (empty)', () => {
  expect(resolveBudget({})).toEqual({})
})

test('resolveBudget: stakes default applies when no explicit cap', () => {
  expect(resolveBudget({}, 'side')).toEqual(STAKES_BUDGET_DEFAULTS.side)
  expect(resolveBudget({}, 'experiment')).toEqual(STAKES_BUDGET_DEFAULTS.experiment)
})

test('resolveBudget: explicit cap wins over the stakes default, per period', () => {
  // daily explicit, monthly inherits the stakes default
  expect(resolveBudget({ dailyUsd: 99 }, 'main-income')).toEqual({
    dailyUsd: 99,
    monthlyUsd: STAKES_BUDGET_DEFAULTS['main-income'].monthlyUsd,
  })
})

test('resolveBudget: income/client are generous, experiment tiny', () => {
  expect(STAKES_BUDGET_DEFAULTS['main-income'].monthlyUsd).toBeGreaterThan(STAKES_BUDGET_DEFAULTS.side.monthlyUsd)
  expect(STAKES_BUDGET_DEFAULTS.side.monthlyUsd).toBeGreaterThan(STAKES_BUDGET_DEFAULTS.experiment.monthlyUsd)
  expect(STAKES_BUDGET_DEFAULTS.client).toEqual(STAKES_BUDGET_DEFAULTS['main-income'])
})
