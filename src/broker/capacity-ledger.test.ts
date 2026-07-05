/**
 * Capacity ledger tests (plan-quest-engine §9). A stubbed ORACLE stands in for
 * smart-balance telemetry (the packet's Verify note: end-to-end dispatch needs
 * H1 merged; until then, unit-verify with the stub). Covers: overshoot
 * prevention across N parallel dispatches, floor respected, time-aware ramp,
 * fail-closed on null telemetry, deny stays queued, computed sleep from window
 * roll-off, starvation record, and §14 reconstruction after a simulated restart.
 */

import { describe, expect, test } from 'bun:test'
import type { CapacityDecision } from '../shared/protocol'
import { DEFAULT_CAPACITY_FLOOR } from './capacity-floor'
import { CapacityLedger } from './capacity-ledger'
import { reconstructLedger } from './capacity-recovery'
import type { CapacityConfig, HeadroomOracle, ProfileHeadroomReading, TaskCtx } from './capacity-types'

// A round 1M-token window so token<->percent is trivial: 1% == 10k tokens.
const WINDOW = 1_000_000
const baseConfig: CapacityConfig = {
  enabled: true,
  windowTokenBudget: WINDOW,
  defaultEstimateTokens: 50_000,
  floor: { baseFloorFraction: 0, morningRampMultiplier: 1, rampHours: 0 }, // floor off unless a test sets it
}

const ctx = (taskId: string): TaskCtx => ({ project: 'proj', runId: '2026-07-05', taskId })

/** Build a ledger with a fixed oracle map and captured decisions. */
function makeLedger(
  readings: Record<string, ProfileHeadroomReading | null>,
  config: Partial<CapacityConfig> = {},
  now = 1_000_000,
): { ledger: CapacityLedger; decisions: CapacityDecision[] } {
  const decisions: CapacityDecision[] = []
  const oracle: HeadroomOracle = p => (p in readings ? readings[p] : null)
  const ledger = new CapacityLedger({
    config: { ...baseConfig, ...config },
    oracle,
    emit: d => decisions.push(d),
    now: () => now,
  })
  return { ledger, decisions }
}

describe('headroom + admission', () => {
  test('admits when the estimate fits the gate headroom', () => {
    // used 25% -> room to the 75% gate = 50% of window = 500k tokens.
    const { ledger, decisions } = makeLedger({ default: { fiveHourPct: 25 } })
    const res = ledger.admitBest(ctx('001'), ['default'], 100_000, 'ref-1')
    expect(res.admitted).toBe(true)
    expect(res.profile).toBe('default')
    expect(decisions.at(-1)?.verdict).toBe('reserve')
    expect(ledger.outstandingTokens('default')).toBe(100_000)
  })

  test('denies (queues) when the estimate exceeds headroom -- never errors', () => {
    // used 72% -> room = 3% of window = 30k tokens; ask for 100k.
    const { ledger, decisions } = makeLedger({ default: { fiveHourPct: 72 } })
    const res = ledger.admitBest(ctx('001'), ['default'], 100_000, 'ref-1')
    expect(res.admitted).toBe(false)
    expect(res.profile).toBeUndefined()
    expect(decisions.at(-1)?.verdict).toBe('deny')
    expect(ledger.outstandingTokens('default')).toBe(0) // nothing reserved
  })

  test('N parallel dispatches never collectively overshoot the gate', () => {
    // used 0% -> full 75% headroom = 750k tokens. Each task wants 200k.
    // Only 3 fit (600k); the 4th must be denied (would breach the gate).
    const { ledger } = makeLedger({ default: { fiveHourPct: 0 } })
    const results = [1, 2, 3, 4].map(i => ledger.admitBest(ctx(`00${i}`), ['default'], 200_000, `ref-${i}`))
    expect(results.filter(r => r.admitted).length).toBe(3)
    expect(results.filter(r => !r.admitted).length).toBe(1)
    expect(ledger.outstandingTokens('default')).toBe(600_000)
    // reserved total stays under the 750k gate headroom -- no overshoot.
    expect(ledger.outstandingTokens('default')).toBeLessThanOrEqual(750_000)
  })

  test('picks the emptiest candidate profile', () => {
    const { ledger } = makeLedger({ a: { fiveHourPct: 60 }, b: { fiveHourPct: 10 } })
    const res = ledger.admitBest(ctx('001'), ['a', 'b'], 100_000, 'ref-1')
    expect(res.admitted).toBe(true)
    expect(res.profile).toBe('b') // b has far more headroom
  })
})

describe('floor', () => {
  test('floor eats into available capacity', () => {
    // used 0% -> 750k headroom, but a flat 50% floor reserves 500k -> only 250k free.
    const cfg: Partial<CapacityConfig> = {
      floor: { baseFloorFraction: 0.5, morningRampMultiplier: 1, rampHours: 0 },
    }
    const { ledger } = makeLedger({ default: { fiveHourPct: 0 } }, cfg)
    expect(ledger.admitBest(ctx('001'), ['default'], 250_000, 'ref-1').admitted).toBe(true)
    // a second 250k would need 500k total > 250k free -> denied.
    expect(ledger.admitBest(ctx('002'), ['default'], 250_000, 'ref-2').admitted).toBe(false)
  })

  test('time-aware ramp shrinks available capacity toward morning', () => {
    const windowEnd = 100 * 60 * 60 * 1000
    const cfg: Partial<CapacityConfig> = { floor: DEFAULT_CAPACITY_FLOOR } // 0.1 -> 0.2 in last 2h
    // At window end the floor is 0.2 (200k). used 0 -> 750k headroom -> 550k free.
    const { ledger: atEnd } = makeLedger({ default: { fiveHourPct: 0 } }, cfg, windowEnd)
    expect(atEnd.admitBest(ctx('001'), ['default'], 550_000, 'r', { windowEndMs: windowEnd }).admitted).toBe(true)
    const { ledger: atEnd2 } = makeLedger({ default: { fiveHourPct: 0 } }, cfg, windowEnd)
    expect(atEnd2.admitBest(ctx('001'), ['default'], 560_000, 'r', { windowEndMs: windowEnd }).admitted).toBe(false)
  })
})

describe('fail closed (§9e)', () => {
  test('null telemetry -> available 0 -> deny', () => {
    const { ledger, decisions } = makeLedger({ default: null })
    const res = ledger.admitBest(ctx('001'), ['default'], 1, 'ref-1')
    expect(res.admitted).toBe(false)
    expect(decisions.at(-1)?.availableTokens).toBe(0)
    expect(decisions.at(-1)?.fiveHourPct).toBeUndefined()
  })

  test('a NaN utilisation reading is treated as fully used (fail closed)', () => {
    const { ledger } = makeLedger({ default: { fiveHourPct: Number.NaN } })
    expect(ledger.admitBest(ctx('001'), ['default'], 1, 'ref-1').admitted).toBe(false)
  })

  test('unknown profile (not in oracle map) -> null -> deny', () => {
    const { ledger } = makeLedger({ default: { fiveHourPct: 0 } })
    expect(ledger.admitBest(ctx('001'), ['ghost'], 1, 'ref-1').admitted).toBe(false)
  })
})

describe('computed sleep (§9d)', () => {
  test('deny carries the soonest window reset as the wake time', () => {
    const reset = 5_000_000
    const { ledger } = makeLedger({
      a: { fiveHourPct: 99, resetAtMs: reset + 1000 },
      b: { fiveHourPct: 99, resetAtMs: reset },
    })
    const res = ledger.admitBest(ctx('001'), ['a', 'b'], 100_000, 'ref-1')
    expect(res.admitted).toBe(false)
    expect(res.sleepUntil).toBe(reset) // earliest of the two
  })

  test('no reset clock available -> no computed wake (falls back to next tick)', () => {
    const { ledger } = makeLedger({ default: { fiveHourPct: 99 } })
    expect(ledger.admitBest(ctx('001'), ['default'], 100_000, 'ref-1').sleepUntil).toBeUndefined()
  })
})

describe('settle', () => {
  test('settle releases the reservation and emits actual', () => {
    const { ledger, decisions } = makeLedger({ default: { fiveHourPct: 0 } })
    ledger.admitBest(ctx('001'), ['default'], 100_000, 'ref-1')
    expect(ledger.outstandingTokens('default')).toBe(100_000)
    ledger.settle('ref-1', 88_000)
    expect(ledger.outstandingTokens('default')).toBe(0)
    const settle = decisions.at(-1)
    expect(settle?.verdict).toBe('settle')
    expect(settle?.estimateTokens).toBe(88_000)
  })

  test('settle on an unknown ref is a no-op (admission was disabled at dispatch)', () => {
    const { ledger, decisions } = makeLedger({ default: { fiveHourPct: 0 } })
    ledger.settle('never-reserved')
    expect(decisions.length).toBe(0)
  })
})

describe('starve (§9f)', () => {
  test('emits a structured starvation record with the numbers + returns the reason', () => {
    // used 74% -> only 1% headroom = 10k available; task needs 100k.
    const { ledger, decisions } = makeLedger({ default: { fiveHourPct: 74 } })
    const reason = ledger.starve(ctx('009'), ['default'], 100_000)
    const d = decisions.at(-1)
    expect(d?.verdict).toBe('starve')
    expect(d?.reason).toMatch(/needed 100,000 tok/)
    expect(d?.availableTokens).toBe(10_000)
    expect(reason).toBe(d?.reason ?? '')
  })
})

describe('§14 reconstruction after restart', () => {
  test('a fresh ledger + reconstruct == the pre-restart outstanding', () => {
    // Before restart: two admitted tasks.
    const { ledger: before } = makeLedger({ default: { fiveHourPct: 0 } })
    before.admitBest(ctx('001'), ['default'], 300_000, 'conv-a')
    before.admitBest(ctx('002'), ['default'], 200_000, 'conv-b')
    const outstandingBefore = before.outstandingTokens('default')

    // After restart: fresh ledger, rebuild from the still-in-flight convs.
    const { ledger: after } = makeLedger({ default: { fiveHourPct: 0 } })
    reconstructLedger(after, [
      {
        id: 'conv-a',
        project: 'proj',
        resolvedProfile: 'default',
        usedTokens: 300_000,
        nightshift: { runId: '2026-07-05', taskId: '001' },
      },
      {
        id: 'conv-b',
        project: 'proj',
        resolvedProfile: 'default',
        usedTokens: 200_000,
        nightshift: { runId: '2026-07-05', taskId: '002' },
      },
    ])
    expect(after.outstandingTokens('default')).toBe(outstandingBefore)
    expect(after.outstandingTokens('default')).toBe(500_000)
  })

  test('reconstruction floors the estimate at the config default for a just-started conv', () => {
    const { ledger } = makeLedger({ default: { fiveHourPct: 0 } })
    reconstructLedger(ledger, [
      {
        id: 'conv-x',
        project: 'proj',
        resolvedProfile: 'work',
        usedTokens: 0,
        nightshift: { runId: 'r', taskId: '001' },
      },
    ])
    expect(ledger.outstandingTokens('work')).toBe(baseConfig.defaultEstimateTokens)
  })

  test('reconstruction attributes to the actual resolved profile, default when absent', () => {
    const { ledger } = makeLedger({ default: { fiveHourPct: 0 } })
    reconstructLedger(ledger, [
      { id: 'c1', project: 'proj', usedTokens: 10, nightshift: { runId: 'r', taskId: '001' } },
    ])
    expect(ledger.outstandingTokens('default')).toBe(baseConfig.defaultEstimateTokens)
  })
})

describe('disabled ledger', () => {
  test('enabled flag reflects config', () => {
    const { ledger } = makeLedger({ default: { fiveHourPct: 0 } }, { enabled: false })
    expect(ledger.enabled).toBe(false)
  })
})
