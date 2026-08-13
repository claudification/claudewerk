/**
 * The normaliser is where a model swap silently corrupts a transcript, so the
 * cases below are the real recorded shapes from live Workers AI sockets
 * (2026-08-13), not invented ones.
 *
 * The bug these exist to prevent: flux's `transcript` is the WHOLE TURN SO FAR.
 * Appending it the way you would append a nova-3 delta duplicates every word,
 * and it looks plausible enough in a short test to ship.
 */

import { describe, expect, it } from 'bun:test'
import { normalize, TranscriptAccumulator } from './normalize'

// Defaults by SPREAD, not by `??` or default params -- each of those is a branch,
// and these helpers were failing the complexity gate on nothing but their own
// signatures.
const V1_DEFAULTS = { start: 0, duration: 1 }
const v1 = (transcript: string, isFinal: boolean, o: Partial<typeof V1_DEFAULTS> = {}) => {
  const { start, duration } = { ...V1_DEFAULTS, ...o }
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    start,
    duration,
    channel: { alternatives: [{ transcript }] },
  })
}

const TURN_DEFAULTS = { index: 0, windowEnd: 1, confidence: 0.1 }
const turn = (transcript: string, event: string, o: Partial<typeof TURN_DEFAULTS> = {}) => {
  const { index, windowEnd, confidence } = { ...TURN_DEFAULTS, ...o }
  return JSON.stringify({
    type: 'TurnInfo',
    event,
    turn_index: index,
    audio_window_end: windowEnd,
    end_of_turn_confidence: confidence,
    transcript,
  })
}

/** Assert a frame came back, then return it. Optional chaining in every
 *  expectation reads fine but makes each test a branch pile -- and a null frame
 *  would silently pass `expect(undefined).toBe(undefined)` instead of failing. */
function frameOf(event: ReturnType<typeof normalize>) {
  const frame = event?.frame
  if (!frame) throw new Error('expected a transcript frame, got none')
  return frame
}

describe('nova-3 (v1 segment deltas)', () => {
  it('accumulates finals and leaves interims uncommitted', () => {
    const acc = new TranscriptAccumulator()
    normalize(acc, v1('hello', false))
    const midway = frameOf(normalize(acc, v1('hello there', false)))
    expect(midway.committed).toBe('')
    expect(midway.text).toBe('hello there')

    normalize(acc, v1('hello there.', true))
    const next = frameOf(normalize(acc, v1('how are', false)))
    expect(next.committed).toBe('hello there. ')
    expect(acc.finalText()).toBe('hello there.')
  })

  it('reports committed as the state the frame sits ON, not after it', () => {
    const acc = new TranscriptAccumulator()
    const final = frameOf(normalize(acc, v1('first.', true)))
    // The client renders committed + text; if commit happened first, this frame
    // would render "first. first." -- the duplication bug, in v1 clothing.
    expect(final.committed).toBe('')
    expect(final.text).toBe('first.')
    expect(`${final.committed}${final.text}`).toBe('first.')
  })

  it('carries the decoded audio position for the lag meter', () => {
    const acc = new TranscriptAccumulator()
    expect(frameOf(normalize(acc, v1('x', false, { start: 4.5, duration: 1.25 }))).audioEndMs).toBe(5750)
  })
})

describe('flux (cumulative turns)', () => {
  it('does NOT append the cumulative transcript to itself', () => {
    const acc = new TranscriptAccumulator()
    normalize(acc, turn('Okay so', 'StartOfTurn'))
    normalize(acc, turn('Okay so I want', 'Update'))
    const last = frameOf(normalize(acc, turn('Okay so I want to add a new endpoint', 'Update')))
    expect(last.text).toBe('Okay so I want to add a new endpoint')
    expect(last.committed).toBe('')
    expect(`${last.committed}${last.text}`).toBe('Okay so I want to add a new endpoint')
  })

  it('ends a turn with a PARAGRAPH break and starts the next one clean', () => {
    const acc = new TranscriptAccumulator()
    normalize(acc, turn('First thought.', 'EndOfTurn'))
    const second = frameOf(normalize(acc, turn('Second thought', 'Update', { index: 1 })))
    expect(second.committed).toBe('First thought.\n\n')
    expect(second.text).toBe('Second thought')
    normalize(acc, turn('Second thought.', 'EndOfTurn', { index: 1 }))
    expect(acc.finalText()).toBe('First thought.\n\nSecond thought.')
  })

  it('keeps an unfinished turn when the user releases mid-sentence', () => {
    const acc = new TranscriptAccumulator()
    normalize(acc, turn('Done.', 'EndOfTurn'))
    normalize(acc, turn('still talking when the key came up', 'Update', { index: 1 }))
    // Push-to-talk release must not discard the live turn.
    expect(acc.finalText()).toBe('Done.\n\nstill talking when the key came up')
  })

  it('closes a turn even if its EndOfTurn never arrived', () => {
    const acc = new TranscriptAccumulator()
    normalize(acc, turn('first turn text', 'Update'))
    // turn_index jumps with no EndOfTurn -- a dropped event must not merge turns.
    normalize(acc, turn('second turn text', 'Update', { index: 1 }))
    expect(acc.finalText()).toBe('first turn text\n\nsecond turn text')
  })

  it('surfaces end-of-turn confidence for tuning', () => {
    const acc = new TranscriptAccumulator()
    expect(frameOf(normalize(acc, turn('mm', 'Update', { confidence: 0.87 }))).endOfTurnConfidence).toBe(0.87)
  })
})

describe('control messages', () => {
  it('treats Metadata as done and Connected as nothing', () => {
    const acc = new TranscriptAccumulator()
    expect(normalize(acc, JSON.stringify({ type: 'Metadata' }))?.done).toBe(true)
    expect(normalize(acc, JSON.stringify({ type: 'Connected' }))).toBeNull()
  })

  it('surfaces an upstream Error', () => {
    const acc = new TranscriptAccumulator()
    const raw = JSON.stringify({ type: 'Error', code: 'UNPARSABLE_CLIENT_MESSAGE', description: 'unknown variant' })
    expect(normalize(acc, raw)?.error).toBe('unknown variant')
  })

  it('ignores unknown types and unparseable frames instead of throwing', () => {
    const acc = new TranscriptAccumulator()
    expect(normalize(acc, JSON.stringify({ type: 'SomethingNew' }))).toBeNull()
    expect(normalize(acc, 'not json at all')).toBeNull()
  })
})
