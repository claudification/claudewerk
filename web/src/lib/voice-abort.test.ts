import { describe, expect, it } from 'vitest'
import { isSendable } from '@/hooks/use-voice-auto-submit'
import { ABORT_PHRASES, isAbortedDictation } from './voice-abort'

describe('isAbortedDictation', () => {
  it('fires when a kill phrase is the last thing said', () => {
    expect(isAbortedDictation('go and refactor the broker, cancel cancel')).toBe(true)
    expect(isAbortedDictation('rewrite the sentinel. Scratch all that.')).toBe(true)
    expect(isAbortedDictation('do the thing -- forget all of that')).toBe(true)
  })

  it('fires on a bare kill phrase with nothing before it', () => {
    expect(isAbortedDictation('cancel cancel')).toBe(true)
    expect(isAbortedDictation('  Cancel, cancel!  ')).toBe(true)
  })

  it('ignores ASR punctuation and casing entirely', () => {
    // Punctuation is the speech model's guess, so it must never decide this.
    expect(isAbortedDictation('ship it. CANCEL -- CANCEL!!')).toBe(true)
    expect(isAbortedDictation('ship it, cancel... cancel')).toBe(true)
  })

  it('REGRESSION: a single "cancel" or "abort" is NOT a kill phrase', () => {
    // These are words you genuinely say to a coding agent. Eating the sentence
    // would be worse than having no kill phrase at all, because the words are
    // gone and nothing says why.
    expect(isAbortedDictation('wire up an AbortSignal so we can abort')).toBe(false)
    expect(isAbortedDictation('make the request cancel')).toBe(false)
    expect(isAbortedDictation('it aborts on the second retry')).toBe(false)
    expect(isAbortedDictation('add a cancel button')).toBe(false)
  })

  it('REGRESSION: a kill phrase mid-sentence does not fire -- only the tail', () => {
    // This exact sentence has to survive being dictated, or the feature cannot
    // be discussed out loud.
    expect(isAbortedDictation('cancel cancel is the kill phrase, add it to the docs')).toBe(false)
    expect(isAbortedDictation('when I say scratch all that it should discard')).toBe(false)
  })

  it('treats empty and whitespace-only input as not-an-abort', () => {
    expect(isAbortedDictation('')).toBe(false)
    expect(isAbortedDictation('   ')).toBe(false)
    expect(isAbortedDictation('...')).toBe(false)
  })

  it('every configured phrase actually fires, alone and at a tail', () => {
    for (const phrase of ABORT_PHRASES) {
      expect(isAbortedDictation(phrase), phrase).toBe(true)
      expect(isAbortedDictation(`some preceding words ${phrase}`), phrase).toBe(true)
    }
  })

  it('every configured phrase is multi-word, so none can fire on one spoken word', () => {
    // The safety property of the whole feature. A single-word phrase added here
    // by a future edit would be able to eat a real sentence.
    for (const phrase of ABORT_PHRASES) {
      expect(phrase.split(' ').length, phrase).toBeGreaterThan(1)
    }
  })
})

describe('isSendable -- the single gate every transport crosses', () => {
  it('blocks an aborted dictation even if only the RAW form carries the phrase', () => {
    // The refiner is told not to obey the transcript, but it is an LLM: it may
    // reword or drop the tail. The raw form is the ground truth for intent.
    expect(isSendable('go and refactor the broker', 'go and refactor the broker, cancel cancel')).toBe(false)
  })

  it('blocks when only the OUTGOING form carries it', () => {
    expect(isSendable('do the thing cancel cancel', 'do the thing')).toBe(false)
  })

  it('blocks empty and whitespace-only text', () => {
    expect(isSendable('', 'something')).toBe(false)
    expect(isSendable('   ', 'something')).toBe(false)
  })

  it('allows an ordinary dictation through untouched', () => {
    expect(isSendable('restart the sentinel please', 'restart the sentinel please')).toBe(true)
    // And the sentence that talks ABOUT the feature still sends.
    expect(isSendable('cancel cancel is the kill phrase', 'cancel cancel is the kill phrase')).toBe(true)
  })
})
