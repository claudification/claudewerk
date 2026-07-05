/**
 * Capacity admission policy tests (§9a/§9d/§9f). Drives `fillSlotsWithAdmission`
 * with a real ledger + a stubbed oracle and recording callbacks -- no orchestrator
 * I/O. Covers: admit-until-headroom, deny leaves the task queued, park sets the
 * computed wake, a cheaper task admits past a denied expensive one, and window
 * close stamps the remainder SKIPPED(capacity).
 */

import { describe, expect, test } from 'bun:test'
import type { NightshiftQueueItem } from '../shared/nightshift-types'
import { type AdmissionRun, fillSlotsWithAdmission } from './capacity-admission'
import { CapacityLedger } from './capacity-ledger'
import type { CapacityConfig, HeadroomOracle, ProfileHeadroomReading } from './capacity-types'

const WINDOW = 1_000_000
const config: CapacityConfig = {
  enabled: true,
  windowTokenBudget: WINDOW,
  defaultEstimateTokens: 200_000,
  floor: { baseFloorFraction: 0, morningRampMultiplier: 1, rampHours: 0 },
}

function ledgerWith(readings: Record<string, ProfileHeadroomReading | null>): CapacityLedger {
  const oracle: HeadroomOracle = p => (p in readings ? readings[p] : null)
  return new CapacityLedger({ config, oracle, emit: () => {}, now: () => 1_000 })
}

function item(id: string, estimateTokens?: number): NightshiftQueueItem {
  return { id, title: `task ${id}`, project: 'proj', status: 'queued', created: '', body: '', estimateTokens }
}

function makeRun(pending: NightshiftQueueItem[], over: Partial<AdmissionRun> = {}): AdmissionRun {
  return {
    project: 'proj',
    runId: 'r',
    candidateProfiles: ['default'],
    concurrency: 8,
    pending,
    inflight: new Map(),
    ...over,
  }
}

function callbacks() {
  const dispatched: string[] = []
  const starved: Array<{ id: string; reason: string }> = []
  return {
    dispatched,
    starved,
    cb: {
      dispatch: async (it: NightshiftQueueItem) => {
        dispatched.push(it.id)
      },
      starveCard: async (it: NightshiftQueueItem, reason: string) => {
        starved.push({ id: it.id, reason })
      },
      now: () => 1_000,
    },
  }
}

describe('fillSlotsWithAdmission', () => {
  test('admits up to headroom, leaves the rest QUEUED (not errored)', async () => {
    // used 0 -> 750k headroom; 5 tasks of 200k -> 3 fit, 2 stay queued.
    const ledger = ledgerWith({ default: { fiveHourPct: 0 } })
    const run = makeRun([item('1'), item('2'), item('3'), item('4'), item('5')])
    const { dispatched, starved, cb } = callbacks()
    await fillSlotsWithAdmission(ledger, run, cb)
    expect(dispatched.length).toBe(3)
    expect(run.pending.map(p => p.id)).toEqual(['4', '5']) // denied tasks remain
    expect(starved.length).toBe(0)
  })

  test('a cheaper task admits past a denied expensive one (no head-of-line block)', async () => {
    // used 60 -> 150k headroom. task1 wants 200k (denied), task2 wants 100k (fits).
    const ledger = ledgerWith({ default: { fiveHourPct: 60 } })
    const run = makeRun([item('1', 200_000), item('2', 100_000)])
    const { dispatched, cb } = callbacks()
    await fillSlotsWithAdmission(ledger, run, cb)
    expect(dispatched).toEqual(['2'])
    expect(run.pending.map(p => p.id)).toEqual(['1'])
  })

  test('nothing admits + nothing running -> park at the computed window reset (§9d)', async () => {
    const reset = 9_999_000
    const ledger = ledgerWith({ default: { fiveHourPct: 99, resetAtMs: reset } })
    const run = makeRun([item('1')])
    const { dispatched, cb } = callbacks()
    await fillSlotsWithAdmission(ledger, run, cb)
    expect(dispatched.length).toBe(0)
    expect(run.sleepUntilMs).toBe(reset)
    expect(run.pending.length).toBe(1)
  })

  test('a parked run does not re-dispatch until the wake time', async () => {
    const ledger = ledgerWith({ default: { fiveHourPct: 0 } })
    const run = makeRun([item('1')], { sleepUntilMs: 10_000 })
    const { dispatched, cb } = callbacks() // cb.now() == 1_000 < 10_000
    await fillSlotsWithAdmission(ledger, run, cb)
    expect(dispatched.length).toBe(0) // still parked
  })

  test('window closed with nothing running -> starve the remainder SKIPPED(capacity) (§9f)', async () => {
    const ledger = ledgerWith({ default: { fiveHourPct: 0 } })
    const run = makeRun([item('1'), item('2')], { windowEndMs: 500 }) // now 1000 > 500 -> closed
    const { dispatched, starved, cb } = callbacks()
    await fillSlotsWithAdmission(ledger, run, cb)
    expect(dispatched.length).toBe(0)
    expect(starved.map(s => s.id)).toEqual(['1', '2'])
    expect(starved[0].reason).toMatch(/capacity: needed/)
    expect(run.pending.length).toBe(0)
  })

  test('window closed but workers still in flight -> wait, do not starve yet', async () => {
    const ledger = ledgerWith({ default: { fiveHourPct: 0 } })
    const run = makeRun([item('1')], { windowEndMs: 500, inflight: new Map([['9', 'conv-9']]) })
    const { starved, cb } = callbacks()
    await fillSlotsWithAdmission(ledger, run, cb)
    expect(starved.length).toBe(0)
    expect(run.pending.length).toBe(1)
  })
})
