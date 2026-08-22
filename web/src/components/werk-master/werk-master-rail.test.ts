import type { EpicActivityEntry } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import { headFacts } from './werk-master-detail'
import { rowFacts } from './werk-master-rail'
import { resumeOptions } from './werk-master-verbs'

function run(over: Partial<EpicActivityEntry> = {}): EpicActivityEntry {
  return {
    epicId: 'e1',
    project: 'claude://default/Users/jonas/projects/alpha',
    status: 'running',
    gen: 3,
    maxGens: 12,
    inFlight: 2,
    werkMasterAlive: false,
    armed: true,
    lastBeatAt: null,
    stale: false,
    ...over,
  }
}

describe('rowFacts', () => {
  it('turns gen/maxGens into a percentage', () => {
    expect(rowFacts(run({ gen: 3, maxGens: 12 })).pct).toBe(25)
  })

  it('never divides by a zero ceiling', () => {
    expect(rowFacts(run({ gen: 3, maxGens: 0 })).pct).toBe(0)
  })

  it('clamps a run that overran its ceiling rather than drawing past the bar', () => {
    expect(rowFacts(run({ gen: 20, maxGens: 12 })).pct).toBe(100)
  })

  it('omits the ceiling from the label when there is none', () => {
    expect(rowFacts(run({ maxGens: 0 })).gens).toBe('gen 3')
    expect(rowFacts(run({ maxGens: 12 })).gens).toBe('gen 3/12')
  })

  it('says "no run" when no artifact is on disk', () => {
    expect(rowFacts(run({ status: null })).status).toBe('no run')
  })

  it('omits the in-flight clause at zero rather than printing "0 in flight"', () => {
    expect(rowFacts(run({ inFlight: 0 })).flight).toBe('')
    expect(rowFacts(run({ inFlight: 2 })).flight).toBe(' . 2 in flight')
  })

  describe('stalled', () => {
    it('is true only when a LIVE run has gone quiet', () => {
      expect(rowFacts(run({ status: 'running', stale: true })).stalled).toBe(true)
    })

    it('is FALSE for a paused run -- it is quiet on purpose, not stuck', () => {
      expect(rowFacts(run({ status: 'paused', stale: true })).stalled).toBe(false)
    })

    it('is false for a live run that is beating', () => {
      expect(rowFacts(run({ status: 'running', stale: false })).stalled).toBe(false)
    })
  })
})

describe('headFacts -- the heading survives a run with no artifact', () => {
  /** Fixed clock: `headFacts` now derives the run's vitality, and a derivation
   *  that reads the wall clock cannot be asked what it thought at any other
   *  moment. */
  const NOW = Date.parse('2026-08-18T06:00:20.000Z')
  const NO_SEATS = {
    armed: false,
    inFlight: [],
    settled: [],
    unacknowledged: [],
    werkMasterAlive: false,
    maxGenSeen: 0,
    conversations: [],
  }
  const bare = {
    epicId: 'e1',
    project: 'p',
    run: null,
    lease: null,
    plan: null,
    live: NO_SEATS,
    beats: [],
    baton: [],
  }
  const live = {
    ...bare,
    run: { gen: 4, maxGens: 16, target: 'merged', concurrency: 3 },
    beats: [{ at: '2026-08-18T05:00:00.000Z' }, { at: '2026-08-18T06:00:00.000Z' }],
  }

  it('falls back to zeroes and dashes rather than rendering undefined', () => {
    const f = headFacts(bare as never, NOW)

    expect(f).toMatchObject({ gen: 0, maxGens: 0, pct: 0, lastBeat: null, target: '-', concurrency: '-' })
  })

  it('reads the run when there is one', () => {
    expect(headFacts(live as never, NOW)).toMatchObject({ gen: 4, maxGens: 16, pct: 25, target: 'merged' })
  })

  it('takes the LAST beat, not the first -- the ring keeps newest last', () => {
    expect(headFacts(live as never, NOW).lastBeat).toBe('2026-08-18T06:00:00.000Z')
  })
})

describe('resumeOptions', () => {
  it('always forces plan off -- a resume must never re-plan a live board', () => {
    expect(resumeOptions({ plan: true, cadence: 'window', target: 'pr', concurrency: 5 } as never).plan).toBe(false)
  })

  it('carries the paused run settings through unchanged', () => {
    expect(resumeOptions({ cadence: ['window'], target: 'pr', concurrency: 5, maxGens: 9 } as never)).toMatchObject({
      cadence: ['window'],
      target: 'pr',
      concurrency: 5,
      maxGens: 9,
    })
  })

  /** A resume is not an edit. It must hand back every gate the run carries --
   *  including one this panel has no control for -- or resuming a queued run
   *  would quietly un-queue it. */
  it('carries a multi-gate `when` axis through without dropping half of it', () => {
    expect(resumeOptions({ cadence: ['window', 'queue'], target: 'pr', concurrency: 1 } as never).cadence).toEqual([
      'window',
      'queue',
    ])
  })

  it('mirrors the engine defaults when the artifact could not be read', () => {
    expect(resumeOptions(null)).toMatchObject({ cadence: ['now'], target: 'merged', concurrency: 3 })
  })
})
