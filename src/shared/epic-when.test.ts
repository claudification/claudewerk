/**
 * THE `when` AXIS CODEC.
 *
 * The interesting cases are all about what an OLDER artifact says: every `run.md`
 * on disk was written when this field could only hold one value, and a parse that
 * lost `window` there would dispatch a night run at noon.
 */

import { describe, expect, it } from 'bun:test'
import {
  formatWhen,
  gatedBy,
  isWhenInstant,
  parseWhen,
  serializeWhen,
  whenInstant,
  whenInstantPassed,
  whenWaitingLine,
} from './epic-when'

describe('parseWhen', () => {
  it('reads the bare scalar every pre-existing run.md carries', () => {
    expect(parseWhen('window')).toEqual(['window'])
    expect(parseWhen('now')).toEqual(['now'])
  })

  it('defaults to no gate when the field is absent or unreadable', () => {
    expect(parseWhen(undefined)).toEqual(['now'])
    expect(parseWhen('')).toEqual(['now'])
    expect(parseWhen('tuesday')).toEqual(['now'])
  })

  it('reads a real list and a joined string the same way', () => {
    expect(parseWhen(['window', 'queue'])).toEqual(['window', 'queue'])
    expect(parseWhen('window,queue')).toEqual(['window', 'queue'])
    expect(parseWhen('queue + window')).toEqual(['window', 'queue'])
  })

  it('normalises to a canonical order, so one axis has one spelling', () => {
    expect(parseWhen(['queue', 'window'])).toEqual(parseWhen(['window', 'queue']))
  })

  it('drops `now` when a real gate rides with it -- `now` IS the absence of one', () => {
    expect(parseWhen(['now', 'queue'])).toEqual(['queue'])
  })

  it('dedupes rather than gating twice on the same thing', () => {
    expect(parseWhen('queue,queue')).toEqual(['queue'])
  })
})

describe('serializeWhen', () => {
  it('writes a lone gate as a bare scalar, so old artifacts keep their bytes', () => {
    expect(serializeWhen(['window'])).toBe('window')
    expect(serializeWhen(['now'])).toBe('now')
  })

  it('writes a real list only when there is one', () => {
    expect(serializeWhen(['window', 'queue'])).toEqual(['window', 'queue'])
  })

  it('round-trips', () => {
    expect(parseWhen(serializeWhen(['window', 'queue']))).toEqual(['window', 'queue'])
    expect(parseWhen(serializeWhen(['queue']))).toEqual(['queue'])
  })
})

describe('gatedBy / formatWhen', () => {
  it('answers per gate rather than by string comparison on the whole axis', () => {
    expect(gatedBy(['window', 'queue'], 'queue')).toBe(true)
    expect(gatedBy(['window'], 'queue')).toBe(false)
    expect(gatedBy(undefined, 'queue')).toBe(false)
  })

  /**
   * VERSION SKEW. Broker and sentinel deploy separately, so a run snapshot can
   * arrive with `cadence` as the bare string it was before this field could hold
   * a list. Both readers must answer about it correctly rather than by whatever
   * `String.prototype.includes` happens to say.
   */
  it('takes the wire value in the shape an OLDER sentinel sends it', () => {
    expect(gatedBy('window' as never, 'window')).toBe(true)
    expect(gatedBy('window' as never, 'queue')).toBe(false)
    expect(gatedBy('now' as never, 'now')).toBe(true)
    expect(formatWhen('window' as never)).toBe('window')
  })

  it('reads as one phrase for a human', () => {
    expect(formatWhen(['window', 'queue'])).toBe('window + queue')
    expect(formatWhen(['now'])).toBe('now')
  })
})

/**
 * THE APPOINTMENT GATE -- `when=2026-08-22T02:00:00+07:00`.
 *
 * The tokenizer is where this card's real risk lives. `when` is joined with `+`
 * on the verb surface and an ISO offset CONTAINS a `+`, so the naive split this
 * codec used to do would tear the zone off the appointment and leave behind a
 * timestamp naming a different hour. For a gate whose entire job is to fire at a
 * stated time, that is the worst available way to be wrong -- and it would be
 * silent, because the mangled remainder still parses.
 */
describe('parseWhen -- the appointment gate', () => {
  const TWO_AM_BANGKOK = 'at:2026-08-22T02:00:00+07:00'

  it('reads an ISO instant as a gate, keeping the offset the human set it in', () => {
    expect(parseWhen('2026-08-22T02:00:00+07:00')).toEqual([TWO_AM_BANGKOK])
  })

  it('DOES NOT SPLIT ON THE `+` INSIDE AN OFFSET -- the whole point of the tokenizer', () => {
    expect(parseWhen('window+2026-08-22T02:00:00+07:00')).toEqual(['window', TWO_AM_BANGKOK])
    expect(parseWhen('2026-08-22T02:00:00+07:00,queue')).toEqual(['queue', TWO_AM_BANGKOK])
  })

  it('accepts the `at:` prefix it writes back, so the artifact round-trips', () => {
    expect(parseWhen(TWO_AM_BANGKOK)).toEqual([TWO_AM_BANGKOK])
    expect(parseWhen(serializeWhen([TWO_AM_BANGKOK]))).toEqual([TWO_AM_BANGKOK])
    expect(serializeWhen([TWO_AM_BANGKOK])).toBe(TWO_AM_BANGKOK)
    expect(parseWhen(serializeWhen(['window', TWO_AM_BANGKOK]))).toEqual(['window', TWO_AM_BANGKOK])
  })

  it('normalises every offset spelling to one, so two runs armed for one moment match', () => {
    expect(parseWhen('2026-08-22T02:00:00+0700')).toEqual([TWO_AM_BANGKOK])
    expect(parseWhen('2026-08-22T02:00+07:00')).toEqual([TWO_AM_BANGKOK])
    expect(parseWhen('2026-08-21T19:00:00.000Z')).toEqual(['at:2026-08-21T19:00:00Z'])
  })

  /**
   * A ZONELESS DATE-TIME IS UTC, EXPLICITLY. `Date.parse` reads that form as LOCAL
   * time per the ES spec, and the broker container runs UTC while the sentinel
   * runs on Jonas's machine -- so the identical `run.md` would name two different
   * moments depending on which process read it. UTC is also the safe direction to
   * be wrong in: the run waits longer than meant rather than firing early.
   */
  it('reads a zoneless instant as UTC rather than as whatever the host clock is', () => {
    expect(parseWhen('2026-08-22T02:00:00')).toEqual(['at:2026-08-22T02:00:00Z'])
    expect(whenInstant('2026-08-22T02:00:00')?.atMs).toBe(Date.parse('2026-08-22T02:00:00Z'))
  })

  it('reads a bare date as midnight UTC rather than dropping it', () => {
    // Dropping it would mean `when=2026-08-22` arms a run that dispatches
    // IMMEDIATELY -- an unknown token falls back to "no gate", and that is the one
    // direction an appointment must never fail in.
    expect(parseWhen('2026-08-22')).toEqual(['at:2026-08-22T00:00:00Z'])
  })

  it('drops an instant that names no real moment', () => {
    expect(parseWhen('at:2026-13-45T99:99:99Z')).toEqual(['now'])
  })

  it('collapses two appointments to the LATEST -- every gate must pass on one beat', () => {
    expect(parseWhen(['at:2026-08-22T02:00:00Z', 'at:2026-08-23T02:00:00Z'])).toEqual(['at:2026-08-23T02:00:00Z'])
    expect(parseWhen(['at:2026-08-23T02:00:00Z', 'at:2026-08-22T02:00:00Z'])).toEqual(['at:2026-08-23T02:00:00Z'])
  })

  it('sorts the appointment LAST, so no run.md that predates it changes shape', () => {
    expect(parseWhen(['at:2026-08-22T02:00:00Z', 'queue', 'window'])).toEqual([
      'window',
      'queue',
      'at:2026-08-22T02:00:00Z',
    ])
  })

  it('drops `now` beside an appointment, exactly as it does beside a named gate', () => {
    expect(parseWhen(['now', TWO_AM_BANGKOK])).toEqual([TWO_AM_BANGKOK])
  })
})

describe('whenInstant / whenInstantPassed / whenWaitingLine', () => {
  const AT = 'at:2026-08-22T02:00:00+07:00'
  /** 2026-08-22T02:00+07:00 is 19:00 UTC the day before. */
  const FIRES_AT = Date.parse('2026-08-21T19:00:00Z')

  it('finds the appointment on an axis carrying other gates too', () => {
    expect(whenInstant(['window', AT])).toMatchObject({ gate: AT, iso: '2026-08-22T02:00:00+07:00', atMs: FIRES_AT })
  })

  it('answers null for every axis that carries no appointment', () => {
    expect(whenInstant(['window', 'queue'])).toBeNull()
    expect(whenInstant(undefined)).toBeNull()
    // Version skew: an older sentinel sends the bare string this field used to be.
    expect(whenInstant('window' as never)).toBeNull()
  })

  it('permits a run with no appointment at any moment at all', () => {
    expect(whenInstantPassed(['queue'], 0)).toBe(true)
    expect(whenWaitingLine(['queue'], 0)).toBeNull()
  })

  it('holds until the instant, then permits -- inclusive on the instant itself', () => {
    expect(whenInstantPassed([AT], FIRES_AT - 1)).toBe(false)
    expect(whenInstantPassed([AT], FIRES_AT)).toBe(true)
    expect(whenInstantPassed([AT], FIRES_AT + 1)).toBe(true)
  })

  /** NEVER A BARE TIME (`format-when.ts`): the line carries the zone the human set
   *  it in AND a countdown, so it is checkable from any clock. */
  it('says what it is waiting for and how long is left, and stops once it has passed', () => {
    const line = whenWaitingLine([AT], FIRES_AT - 4 * 3_600_000)
    expect(line).toBe('waiting until 2026-08-22T02:00:00+07:00 (in 4 hours)')
    expect(whenWaitingLine([AT], FIRES_AT)).toBeNull()
  })

  it('renders the appointment as a phrase, never as a raw gate token', () => {
    expect(formatWhen([AT])).toBe('not before 2026-08-22T02:00:00+07:00')
    expect(formatWhen(['window', AT])).toBe('window + not before 2026-08-22T02:00:00+07:00')
  })

  it('recognises the gate family by shape, since it is not one value', () => {
    expect(isWhenInstant(AT)).toBe(true)
    expect(isWhenInstant('queue')).toBe(false)
  })
})
