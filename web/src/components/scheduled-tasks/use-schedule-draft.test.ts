/**
 * Draft <-> wire mapping, with the one-shot path.
 *
 * The seam that matters: the user types a WALL CLOCK, the wire carries an
 * INSTANT. A conversion that silently picks the wrong instant -- or accepts a
 * time that does not exist in the chosen zone -- produces a task that fires an
 * hour off, or never, with no error anywhere.
 */

import { describe, expect, it } from 'vitest'
import {
  blankDraft,
  draftProblem,
  draftToCreate,
  resolveRunAt,
  type ScheduleDraft,
  toLocalInputValue,
} from './use-schedule-draft'

const BERLIN = 'Europe/Berlin'

function draft(over: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return {
    ...blankDraft('claude:///p', '/p'),
    name: 'nightly',
    prompt: 'do the thing',
    tz: BERLIN,
    ...over,
  }
}

describe('resolveRunAt', () => {
  it('reads the wall clock in the CHOSEN zone, not the browser one', () => {
    // 09:00 Berlin in August is 07:00Z. A naive `new Date(string)` would give 09:00Z.
    expect(resolveRunAt('2026-08-13T09:00', BERLIN)).toBe(Date.parse('2026-08-13T07:00:00Z'))
    expect(resolveRunAt('2026-08-13T09:00', 'UTC')).toBe(Date.parse('2026-08-13T09:00:00Z'))
  })

  it('honours the winter offset too -- proof the zone is really applied', () => {
    expect(resolveRunAt('2026-01-13T09:00', BERLIN)).toBe(Date.parse('2026-01-13T08:00:00Z'))
  })

  it('refuses a wall clock inside the DST spring-forward gap', () => {
    // 02:30 does not exist in Berlin on 2026-03-29.
    expect(resolveRunAt('2026-03-29T02:30', BERLIN)).toBeNull()
  })

  it('refuses malformed text rather than guessing', () => {
    for (const bad of ['', 'tomorrow', '2026-13-45T99:99', '2026-08-13']) {
      expect(resolveRunAt(bad, BERLIN)).toBeNull()
    }
  })

  it('round-trips through toLocalInputValue', () => {
    const ms = Date.parse('2026-08-13T07:00:00Z')
    expect(resolveRunAt(toLocalInputValue(ms, BERLIN), BERLIN)).toBe(ms)
  })
})

describe('toLocalInputValue', () => {
  it('renders the instant as a wall clock in the target zone', () => {
    const ms = Date.parse('2026-08-13T07:00:00Z')
    expect(toLocalInputValue(ms, BERLIN)).toBe('2026-08-13T09:00')
    expect(toLocalInputValue(ms, 'UTC')).toBe('2026-08-13T07:00')
  })

  it('renders midnight as 00:00, not 24:00', () => {
    expect(toLocalInputValue(Date.parse('2026-08-13T00:00:00Z'), 'UTC')).toBe('2026-08-13T00:00')
  })
})

describe('draftToCreate', () => {
  it('a repeating draft sends cron and NO runAt', () => {
    const body = draftToCreate(draft({ mode: 'repeating', cron: '0 9 * * 1-5' }))
    expect(body.cron).toBe('0 9 * * 1-5')
    expect(body.runAt).toBeUndefined()
  })

  it('a one-shot draft sends runAt and NO cron', () => {
    const body = draftToCreate(draft({ mode: 'once', runAtLocal: '2026-08-13T09:00' }))
    expect(body.runAt).toBe(Date.parse('2026-08-13T07:00:00Z'))
    expect(body.cron).toBeUndefined()
  })

  it('never sends both, even though the draft holds both', () => {
    const both = draft({ mode: 'once', cron: '0 9 * * *', runAtLocal: '2026-08-13T09:00' })
    const body = draftToCreate(both)
    expect(body.cron === undefined || body.runAt === undefined).toBe(true)
  })
})

describe('draftProblem -- one-shot', () => {
  const NOW = Date.parse('2026-08-12T07:00:00Z')

  it('accepts a future moment', () => {
    expect(draftProblem(draft({ mode: 'once', runAtLocal: '2026-08-13T09:00' }), NOW)).toBeNull()
  })

  it('rejects a moment that has passed, in plain words', () => {
    expect(draftProblem(draft({ mode: 'once', runAtLocal: '2026-08-01T09:00' }), NOW)).toContain('already passed')
  })

  it('explains a DST-gap time instead of just saying invalid', () => {
    const problem = draftProblem(draft({ mode: 'once', runAtLocal: '2027-03-28T02:30' }), NOW)
    expect(problem).toContain('does not exist')
    expect(problem).toContain(BERLIN)
  })

  it('asks for a time when the field is empty', () => {
    expect(draftProblem(draft({ mode: 'once', runAtLocal: '' }), NOW)).toContain('Pick when')
  })

  it('does NOT complain about the cron field while in once mode', () => {
    const d = draft({ mode: 'once', cron: 'total nonsense', runAtLocal: '2026-08-13T09:00' })
    expect(draftProblem(d, NOW)).toBeNull()
  })

  it('still demands the universal fields', () => {
    expect(draftProblem(draft({ mode: 'once', prompt: '', runAtLocal: '2026-08-13T09:00' }), NOW)).toContain('prompt')
    expect(draftProblem(draft({ mode: 'once', name: '', runAtLocal: '2026-08-13T09:00' }), NOW)).toContain('name')
  })
})

describe('blankDraft', () => {
  it('starts repeating -- the common case', () => {
    expect(blankDraft('claude:///p', '/p').mode).toBe('repeating')
  })

  it('pre-fills a one-shot moment so the field is never empty', () => {
    const d = blankDraft('claude:///p', '/p')
    const resolved = resolveRunAt(d.runAtLocal, d.tz)
    expect(resolved).not.toBeNull()
    expect(resolved as number).toBeGreaterThan(Date.now())
  })
})
