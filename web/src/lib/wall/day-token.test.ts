/**
 * THE DAY AXIS -- the half of the grammar the activity matrix added, proved as a
 * grammar rather than through the pane.
 *
 * The claim under test is not "a square is clickable". It is that a day and a
 * window are the SAME axis wearing two shapes, so a pane that already declared
 * `time` narrows on a day it has never heard of, and a pane that did not is left
 * completely alone by one. That guarantee lives in `axes.ts` and is invisible
 * from inside any single pane.
 */

import { describe, expect, it } from 'vitest'
import { localDayKey, matchesPulseQuery, parseDay, parsePulseQuery } from '@/lib/pulse/filter'
import { restrictToAxes } from './axes'
import { stripDayTokens, toggledDay, withDay } from './day-token'
import { useWallFilterStore } from './filter-store'

/** A row of a given age, filled out to what the matcher wants. */
const aged = (ageMs: number) => ({ title: '', project: '', action: '', ageMs, band: 'idle' as const })

describe('the ~ sigil carries two shapes of "when"', () => {
  it('reads a bare ISO date as ONE DAY, not as a window', () => {
    const q = parsePulseQuery('~2026-08-14')
    expect(q.day).toBe('2026-08-14')
    expect(q.windowMs).toBeNull()
  })

  it('still reads the window form, and the two compose in one query', () => {
    const q = parsePulseQuery('~30m ~2026-08-14')
    expect(q.windowMs).toBe(30 * 60_000)
    expect(q.day).toBe('2026-08-14')
  })

  it('REFUSES a date that does not exist, rather than emptying the wall', () => {
    // `~2026-02-30` is well-formed and never happened. Accepted, it would be a
    // filter no row can satisfy -- every pane on the `time` axis blank, with
    // nothing on screen saying why.
    expect(parseDay('~2026-02-30')).toBeNull()
    const q = parsePulseQuery('~2026-02-30')
    expect(q.day).toBeNull()
    expect(q.text).toBe('~2026-02-30')
  })

  it('leaves a quoted date as free text', () => {
    expect(parsePulseQuery('"~2026-08-14"').day).toBeNull()
  })
})

describe("a day matches in the READER's calendar, never in UTC", () => {
  it('THE REGRESSION: an evening stays on the day it was lived', () => {
    // The two instants that straddle LOCAL midnight. A `toISOString().slice(0,10)`
    // reading puts both on the same square in every zone east of Greenwich and on
    // different-but-shifted squares west of it -- either way the pane hands back
    // rows from a day the reader did not click. Nothing here names a zone, so it
    // holds under whatever the runner's TZ happens to be.
    const endOfDay = new Date(2026, 7, 14, 23, 59, 59).getTime()
    const startOfNext = new Date(2026, 7, 15, 0, 0, 1).getTime()
    expect(localDayKey(endOfDay)).toBe('2026-08-14')
    expect(localDayKey(startOfNext)).toBe('2026-08-15')

    // ...and the matcher inherits that reading rather than re-deriving one.
    const now = Date.now()
    const q = parsePulseQuery('~2026-08-14')
    expect(matchesPulseQuery(aged(now - endOfDay), q)).toBe(true)
    expect(matchesPulseQuery(aged(now - startOfNext), q)).toBe(false)
  })

  it('keeps a row that is on the day and drops one that is not', () => {
    const now = Date.now()
    const today = localDayKey(now)
    const q = parsePulseQuery(`~${today}`)
    expect(matchesPulseQuery(aged(0), q)).toBe(true)
    expect(matchesPulseQuery(aged(9 * 86_400_000), q)).toBe(false)
  })
})

describe('the day rides the `time` axis, so no pane file had to learn it', () => {
  it('is CLEARED for a pane that never declared time', () => {
    const q = parsePulseQuery('~2026-08-14')
    // A commit river understands projects, not clocks. Left in, a day click
    // would blank it -- the blank-pane failure `axes.ts` exists to refuse.
    expect(restrictToAxes(q, ['project', 'text']).day).toBeNull()
  })

  it('SURVIVES for a pane that did', () => {
    expect(restrictToAxes(parsePulseQuery('~2026-08-14'), ['time']).day).toBe('2026-08-14')
  })
})

describe('the square action round-trips through the header box', () => {
  it('writes the token a human would have typed, and a second click clears it', () => {
    const store = useWallFilterStore.getState()
    store.clear()
    store.toggleDay('2026-08-14')
    expect(useWallFilterStore.getState().raw).toBe('~2026-08-14')
    expect(useWallFilterStore.getState().query.day).toBe('2026-08-14')

    useWallFilterStore.getState().toggleDay('2026-08-14')
    expect(useWallFilterStore.getState().raw).toBe('')
  })

  it('swaps one day for another instead of stacking them', () => {
    const store = useWallFilterStore.getState()
    store.clear()
    store.setRaw('@anvil ~2026-08-14')
    store.toggleDay('2026-08-15')
    expect(useWallFilterStore.getState().raw).toBe('@anvil ~2026-08-15')
  })

  it('leaves a WINDOW token alone -- the two shapes compose', () => {
    expect(withDay('~30m @anvil', '2026-08-14')).toBe('~30m @anvil ~2026-08-14')
    expect(stripDayTokens('~30m ~2026-08-14').had).toBe('2026-08-14')
    expect(stripDayTokens('~30m ~2026-08-14').kept).toEqual(['~30m'])
  })

  it('drops the scope entirely on a null day', () => {
    expect(withDay('@anvil ~2026-08-14', null)).toBe('@anvil')
  })

  it('does not touch a QUOTED date', () => {
    expect(toggledDay('"~2026-08-14"', '2026-08-15')).toBe('"~2026-08-14" ~2026-08-15')
  })
})
