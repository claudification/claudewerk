/**
 * THE ONE LIVENESS TEST, tested once.
 *
 * A7 used to hold two of these -- `runVitality` for epic rows and
 * `conv.status !== 'ended'` for night ones -- and rendered the union, so a
 * paused epic with a live overseer conversation was indistinguishable from a
 * working one. These cases are the contract that says they cannot drift apart
 * again: every row, of either kind, gets its verdict from `rowLiveness`, and
 * every verdict carries a reason.
 *
 * Pure on purpose. The pane suite (`../unattended-runs.test.tsx`) asserts what
 * this ordering LOOKS like; this one asserts what it IS, without a DOM.
 */

import type { EpicActivityEntry } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import { rowLiveness, rowTitle, runSections } from './run-liveness'
import type { UnattendedRow } from './use-unattended-runs'

const NOW = Date.parse('2026-08-20T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function epic(epicId: string, over: Partial<EpicActivityEntry> = {}): UnattendedRow {
  return {
    kind: 'epic',
    key: `epic ${epicId}`,
    project: 'claude:///Users/j/remote-claude',
    projectName: 'remote-claude',
    epicId,
    entry: {
      epicId,
      project: 'claude:///Users/j/remote-claude',
      status: 'armed',
      gen: 3,
      maxGens: 40,
      inFlight: 2,
      overseerAlive: true,
      armed: true,
      lastBeatAt: iso(20_000),
      stale: false,
      ...over,
    },
  }
}

function night(runId: string, liveWorkers: number): UnattendedRow {
  return {
    kind: 'nightshift',
    key: `night ${runId}`,
    project: 'claude:///Users/j/remote-claude',
    projectName: 'remote-claude',
    runId,
    liveWorkers,
  }
}

describe('rowLiveness -- one question, both feeds', () => {
  it('defers to the SHARED epic derivation rather than re-reading `status`', () => {
    // `status: 'running'` with a dead overseer, no seats and a stale beat is the
    // 2026-08-20 lie. Liveness here must agree with `runVitality`, which calls
    // it STALLED -- still live, because the engine is still supposed to be
    // driving it, and that is exactly what makes it an alarm.
    const stalled = rowLiveness(epic('epic-the-wall-ii', { status: 'running', stale: true, inFlight: 0 }))
    expect(stalled).toMatchObject({ live: true, label: 'STALLED', vitality: 'stalled' })
    expect(stalled.why).not.toBe('')
  })

  it.each([
    ['paused', 'PAUSED'],
    ['aborted', 'ABORTED'],
    ['complete', 'DONE'],
  ] as const)('calls a %s run not-live, with a reason', (status, label) => {
    const liveness = rowLiveness(epic('e', { status }))
    expect(liveness.live).toBe(false)
    expect(liveness.label).toBe(label)
    // The reason is REQUIRED, not decorative: paused, aborted and finished are
    // three different situations and a dimmed row that does not say which is
    // worse than no row.
    expect(liveness.why.length).toBeGreaterThan(0)
  })

  it('calls a night run with a worker up RUNNING, and one with none EXPIRED', () => {
    expect(rowLiveness(night('2026-08-20', 3))).toMatchObject({ live: true, label: 'RUNNING' })
    expect(rowLiveness(night('2026-08-14', 0))).toMatchObject({ live: false, label: 'EXPIRED', vitality: 'expired' })
  })

  it('names a row the same way whatever kind it is', () => {
    expect(rowTitle(epic('epic-the-wall'))).toBe('epic-the-wall')
    expect(rowTitle(night('2026-08-14', 0))).toBe('2026-08-14')
  })
})

describe('runSections -- ranked, never dropped', () => {
  it('puts every live row first and every stopped row last', () => {
    const rows = [epic('paused-one', { status: 'paused' }), epic('live-one'), night('expired', 0), night('night', 2)]
    const { live, tail } = runSections(rows)

    expect(live.map(rowTitle)).toEqual(['live-one', 'night'])
    expect(tail.map(t => rowTitle(t.row))).toEqual(['paused-one', 'expired'])
    // NOTHING IS LOST. The failure this section exists to prevent is a run going
    // quiet unnoticed, so the two halves must add back up to the input.
    expect(live.length + tail.length).toBe(rows.length)
  })

  it('PARTITIONS rather than sorts, so a row does not jump position when it pauses', () => {
    // Incoming order is by project then id. Within each half it survives, which
    // is what keeps an ambient monitor still: motion reads as news.
    const rows = [epic('a'), epic('b', { status: 'paused' }), epic('c'), epic('d', { status: 'aborted' })]
    const { live, tail } = runSections(rows)
    expect(live.map(rowTitle)).toEqual(['a', 'c'])
    expect(tail.map(t => rowTitle(t.row))).toEqual(['b', 'd'])
  })

  it('carries each stopped row its own reason, not a shared one', () => {
    const { tail } = runSections([epic('b', { status: 'paused' }), epic('d', { status: 'aborted' })])
    const whys = tail.map(t => t.liveness.why)
    expect(whys[0]).not.toBe(whys[1])
    expect(whys[0]).toContain('RESUME')
    expect(whys[1]).toContain('aborted')
  })

  it('is empty in every half for an empty feed', () => {
    expect(runSections([])).toEqual({ live: [], tail: [], cleared: [] })
  })
})

/**
 * THE BURIAL, and the two ways it must not misfire: it must never take a LIVE
 * row (the invisibility O2 exists to prevent) and it must never drop a row in
 * silence (which reads as "nothing ended recently", the same lie).
 */
describe('runSections -- the cleared third', () => {
  it('takes an acknowledged dead run off the tail', () => {
    const rows = [
      epic('acked', { status: 'aborted', acknowledgedAt: iso(1000) }),
      epic('still-there', { status: 'aborted' }),
    ]
    const { tail, cleared } = runSections(rows, NOW)

    expect(tail.map(t => rowTitle(t.row))).toEqual(['still-there'])
    expect(cleared.map(t => rowTitle(t.row))).toEqual(['acked'])
  })

  it('ages a long-dead run off on its own, measured from the run file, not the beat', () => {
    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000
    // `lastBeatAt` is RECENT and `updatedAt` is old: a paused run stops beating
    // and keeps being updated, so ageing off the beat would bury it the day it
    // paused. The run file is the fact that matters.
    const rows = [epic('old', { status: 'paused', updatedAt: iso(EIGHT_DAYS), lastBeatAt: iso(1000) })]
    const { tail, cleared } = runSections(rows, NOW)

    expect(tail).toEqual([])
    expect(cleared.map(t => rowTitle(t.row))).toEqual(['old'])
  })

  /** THE ONE THAT MATTERS. An acknowledgement left on a run that started again
   *  would hide it while it was genuinely running. Liveness is asked FIRST. */
  it('never clears a LIVE run, whatever stamps it carries', () => {
    const rows = [epic('running-again', { acknowledgedAt: iso(1000), updatedAt: iso(90 * 24 * 60 * 60 * 1000) })]
    const { live, tail, cleared } = runSections(rows, NOW)

    expect(live.map(rowTitle)).toEqual(['running-again'])
    expect(tail).toEqual([])
    expect(cleared).toEqual([])
  })

  it('still adds back up to the input, so nothing is dropped in silence', () => {
    const rows = [
      epic('a'),
      epic('b', { status: 'paused' }),
      epic('c', { status: 'aborted', acknowledgedAt: iso(1) }),
      night('n', 0),
    ]
    const { live, tail, cleared } = runSections(rows, NOW)

    expect(live.length + tail.length + cleared.length).toBe(rows.length)
  })

  /** A night run has no artifact to acknowledge, so it can only ever age out --
   *  and the feed gives it no stamp at all, so it never leaves on its own. */
  it('keeps an expired night run on the tail, since there is nothing to acknowledge', () => {
    const { tail, cleared } = runSections([night('expired', 0)], NOW)
    expect(tail.map(t => rowTitle(t.row))).toEqual(['expired'])
    expect(cleared).toEqual([])
  })
})
