/**
 * The baton tail and the beat pulse -- how much of a run's log A7 prints.
 *
 * The clamping is the point. A7 is a summary surface sharing a screen with
 * thirteen other panes, and the thing that broke it was a single baton body
 * (agent prose, no line breaks, ~2k characters) rendered whole. Both halves of
 * the guard are tested here because CSS alone was the version that failed.
 */

import type { EpicLogEntry } from '@shared/epic-run-types'
import type { EpicBeatRecord } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import { batonHeadline, batonTail, beatTicks } from './run-tails'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe('the baton tail', () => {
  const log = (ts: string, body: string): EpicLogEntry => ({ ts, kind: 'dispatch', convId: 'c', body })
  const three = () => [log(iso(300_000), 'old'), log(iso(200_000), 'mid'), log(iso(100_000), 'new')]

  it('shows the baton NEWEST FIRST from an oldest-first log', () => {
    expect(batonTail(three(), 2).map(e => e.body)).toEqual(['new', 'mid'])
  })

  it('shows ONE entry by default -- A7 is a summary, not a log', () => {
    expect(batonTail(three()).map(e => e.body)).toEqual(['new'])
  })
})

describe('the baton headline', () => {
  it('takes the FIRST LINE, so a multi-paragraph beat is still one row', () => {
    expect(batonHeadline('  NOTHING TO MERGE.  \n\nAnd here is the essay.\nAnd more.')).toBe('NOTHING TO MERGE.')
  })

  it('caps a body that is one enormous paragraph with no newline at all', () => {
    const headline = batonHeadline('x'.repeat(400))
    expect(headline).toHaveLength(143)
    expect(headline.endsWith('...')).toBe(true)
  })

  it('leaves a short single-line body exactly as written', () => {
    expect(batonHeadline('1 seat working.')).toBe('1 seat working.')
  })
})

describe('the beat pulse', () => {
  it('keeps beats OLDEST-LEFT and marks the ones that did nothing', () => {
    const beat = (n: number, actions: number): EpicBeatRecord => ({
      at: iso(n),
      gen: 1,
      epicId: 'e',
      project: 'p',
      note: '',
      actions,
      spawned: [],
    })
    expect(beatTicks([beat(300, 0), beat(200, 2), beat(100, 0)], 2)).toEqual([
      { at: iso(200), did: true },
      { at: iso(100), did: false },
    ])
  })
})
