import { describe, expect, it } from 'bun:test'
import type { NormalizedUsage } from '../shared/pricing'
import { RECAP_LEDGER_VERSION, RecapLedger } from './ledger'

function usage(over: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costSource: 'openrouter',
    ...over,
  }
}

describe('RecapLedger', () => {
  it('accumulates cost + tokens across calls and stamps the version', () => {
    const l = new RecapLedger()
    l.addCall({
      stage: 'oneshot',
      model: 'opus',
      ms: 1000,
      usage: usage({ inputTokens: 100, outputTokens: 50, costUsd: 0.01 }),
    })
    l.addCall({
      stage: 'retry',
      model: 'opus',
      ms: 800,
      usage: usage({ inputTokens: 120, outputTokens: 60, costUsd: 0.012 }),
    })

    const ledger = l.build()
    expect(ledger.version).toBe(RECAP_LEDGER_VERSION)
    expect(ledger.entries).toHaveLength(2)
    expect(ledger.summary.callCount).toBe(2)
    expect(ledger.summary.totalInputTokens).toBe(220)
    expect(ledger.summary.totalOutputTokens).toBe(110)
    expect(ledger.summary.totalCostUsd).toBeCloseTo(0.022, 6)
  })

  it('records the retry cost the old aggregate dropped', () => {
    const l = new RecapLedger()
    l.addCall({ stage: 'oneshot', model: 'opus', ms: 1, usage: usage({ costUsd: 0.01 }) })
    l.addCall({ stage: 'retry', model: 'opus', ms: 1, usage: usage({ costUsd: 0.005 }) })
    expect(l.totalCostUsd()).toBeCloseTo(0.015, 6)
  })

  it('records cost on a failed call (ok=false), not $0', () => {
    const l = new RecapLedger()
    l.addCall({
      stage: 'oneshot',
      model: 'opus',
      ms: 500,
      ok: false,
      error: 'timeout',
      usage: usage({ inputTokens: 200000, costUsd: 0.9 }),
    })
    const ledger = l.build()
    expect(ledger.entries[0].ok).toBe(false)
    expect(ledger.entries[0].error).toBe('timeout')
    expect(ledger.summary.totalCostUsd).toBeCloseTo(0.9, 6)
  })

  it('rolls up per stage and tracks distinct models + chunk index', () => {
    const l = new RecapLedger()
    l.addCall({ stage: 'map', chunkIndex: 0, model: 'sonnet', ms: 1, usage: usage({ costUsd: 0.001 }) })
    l.addCall({ stage: 'map', chunkIndex: 1, model: 'sonnet', ms: 1, usage: usage({ costUsd: 0.002 }) })
    l.addCall({ stage: 'reduce', model: 'opus', ms: 1, usage: usage({ costUsd: 0.02 }) })

    const { summary, entries } = l.build()
    expect(summary.byStage.map).toEqual({ calls: 2, costUsd: 0.003 })
    expect(summary.byStage.reduce).toEqual({ calls: 1, costUsd: 0.02 })
    expect(summary.models).toEqual(['sonnet', 'opus'])
    expect(entries[1].chunkIndex).toBe(1)
  })

  it('carries the input/output cost split when present', () => {
    const l = new RecapLedger()
    l.addCall({
      stage: 'oneshot',
      model: 'opus',
      ms: 1,
      usage: usage({ costUsd: 0.012, inputCostUsd: 0.009, outputCostUsd: 0.003 }),
    })
    const e = l.build().entries[0]
    expect(e.inputCostUsd).toBe(0.009)
    expect(e.outputCostUsd).toBe(0.003)
  })

  it('omits the split fields when absent', () => {
    const l = new RecapLedger()
    l.addCall({ stage: 'oneshot', model: 'opus', ms: 1, usage: usage({ costUsd: 0.01 }) })
    const e = l.build().entries[0]
    expect(e.inputCostUsd).toBeUndefined()
    expect(e.outputCostUsd).toBeUndefined()
  })
})
