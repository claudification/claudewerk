/**
 * @vitest-environment node
 */
/**
 * Tests for the dictation timing record.
 *
 * WHY THIS IS TESTED AT ALL: the numbers this module produces are the ones that
 * get quoted back as fact. The first version of the "four dead windows" table was
 * argued from code comments and platform lore rather than measured, which is
 * exactly the mistake that ran the voice saga for months. So the arithmetic that
 * turns marks into a verdict has to be pinned -- especially `lostMs`, which is
 * the only number that answers the original complaint.
 */

import { afterEach, describe, expect, test } from 'vitest'
import {
  abandonDictation,
  beginDictation,
  captureGapMs,
  clearDictationHistory,
  type DictationRecord,
  dictationHistory,
  endDictation,
  lostMs,
  mark,
  noteDictation,
  prerollHadSpeech,
} from '@/hooks/voice-timeline'
import { formatDictations, verdict } from '@/lib/voice-timeline-format'

afterEach(() => {
  abandonDictation()
  clearDictationHistory()
})

/** Record one dictation whose marks are forced to known offsets. */
function record(marks: Array<[string, number]>, facts: Partial<DictationRecord> = {}): DictationRecord {
  beginDictation()
  for (const [phase] of marks) mark(phase)
  noteDictation(facts)
  const rec = endDictation() as DictationRecord
  // performance.now() offsets are real and sub-millisecond here; overwrite them
  // so the arithmetic under test is the thing being asserted, not the clock.
  for (const [i, [phase, at]] of marks.entries()) rec.marks[i] = { phase, at }
  return rec
}

describe('the headline number', () => {
  test('lostMs is the capture gap minus what the ring handed back', () => {
    const rec = record(
      [
        ['keydown', 0],
        ['arm', 900],
      ],
      { prerollMs: 400 },
    )

    expect(captureGapMs(rec)).toBe(900)
    expect(lostMs(rec)).toBe(500)
  })

  test('pre-roll longer than the gap loses nothing, and never goes negative', () => {
    const rec = record(
      [
        ['keydown', 0],
        ['arm', 120],
      ],
      { prerollMs: 1500 },
    )

    // Covering the head fully is "nothing lost", not "time gained".
    expect(lostMs(rec)).toBe(0)
    expect(verdict(rec)).toBe('nothing lost')
  })

  test('no pre-roll means the whole gap is lost -- the pre-fix behaviour', () => {
    const rec = record(
      [
        ['keydown', 0],
        ['arm', 670],
      ],
      { prerollMs: 0 },
    )

    expect(lostMs(rec)).toBe(670)
    expect(verdict(rec)).toBe('lost 670ms of speech')
  })
})

describe('was speech actually being lost', () => {
  test('a loud pre-roll counts as speech, a silent one does not', () => {
    const loud = record([['keydown', 0]], { prerollFrames: 28, prerollPeakDb: -21.3 })
    const quiet = record([['keydown', 0]], { prerollFrames: 28, prerollPeakDb: -62 })
    const empty = record([['keydown', 0]], { prerollFrames: 0, prerollPeakDb: Number.NEGATIVE_INFINITY })

    expect(prerollHadSpeech(loud)).toBe(true)
    expect(prerollHadSpeech(quiet)).toBe(false)
    expect(prerollHadSpeech(empty)).toBe(false)
  })
})

describe('the record itself', () => {
  test('marks outside a dictation are dropped, not attached to the last one', () => {
    const rec = record([
      ['keydown', 0],
      ['arm', 10],
    ])
    mark('stray')

    expect(rec.marks.some(m => m.phase === 'stray')).toBe(false)
    expect(endDictation()).toBeNull()
  })

  test('an abandoned press is not kept -- a chord is not a dictation', () => {
    beginDictation()
    mark('grace')
    abandonDictation()

    expect(endDictation()).toBeNull()
    expect(dictationHistory()).toHaveLength(0)
  })

  test('history is newest first, and ids keep counting up across the session', () => {
    const first = record([['keydown', 0]])
    const second = record([['keydown', 0]])

    expect(dictationHistory().map(r => r.id)).toEqual([second.id, first.id])
    // Ids deliberately do NOT reset with the history: "#7 was the bad one" has
    // to stay true after a Clear.
    expect(second.id).toBe(first.id + 1)
  })
})

describe('the paste-ready tree', () => {
  test('carries the verdict, the deltas and the context, inside one fence', () => {
    const rec = record(
      [
        ['keydown', 0],
        ['grace', 71],
        ['mic', 72],
        ['arm', 74],
      ],
      { prerollMs: 1400, prerollFrames: 28, prerollPeakDb: -21.3, micWarm: true, transport: 'direct', model: 'flux' },
    )

    const out = formatDictations([rec])

    expect(out.startsWith('```')).toBe(true)
    expect(out.endsWith('```')).toBe(true)
    expect(out).toContain('nothing lost')
    expect(out).toContain('direct / flux')
    expect(out).toContain('NET LOST     0ms')
    expect(out).toContain('contained speech')
    // Deltas, not just absolutes: the gap BETWEEN seams is what identifies which
    // one is slow, and it must not need mental arithmetic to read.
    expect(out).toContain('+71')
  })

  test('says so plainly when nothing has been measured', () => {
    expect(formatDictations([])).toContain('no dictations measured yet')
  })
})
