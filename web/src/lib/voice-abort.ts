/**
 * voice-abort - the spoken kill switch. Ending a dictation with a kill phrase
 * throws the WHOLE transcript away instead of sending it.
 *
 * The problem it solves: you realise mid-ramble that you are dictating into the
 * wrong conversation, or that the whole thought was wrong. Releasing the key
 * still sends. Reaching for the mouse to cancel means finding the cancel
 * affordance while still holding a key down. Saying so is the only input channel
 * already in your hands.
 *
 * WHY REPEATED WORDS, AND NOT "abort"
 * A bare "abort" is a word you genuinely say to a coding agent -- "abort the
 * request", "wire up an AbortSignal", "it aborts on the second retry". A kill
 * phrase that eats a real sentence is far worse than no kill phrase at all,
 * because the words are gone and there is nothing left to tell you why. So every
 * default is either a DOUBLED word or an explicit multi-word phrase: nobody says
 * "cancel cancel" by accident, and the doubling is the same trick aviation and
 * radio use ("break break", "mayday mayday mayday") for exactly this reason.
 *
 * TAIL-ANCHORED, ALWAYS. The phrase must be the LAST thing said. "cancel cancel
 * is the kill phrase" is a sentence about the feature, not an instruction to
 * discard -- and it must survive being dictated. Matching anywhere in the
 * transcript would eat it.
 */

/**
 * Matched against the end of a finished transcript. Lowercase, no punctuation --
 * `normalize()` strips both sides before comparing.
 *
 * Adding one: it must be something you would never say as the closing words of a
 * real instruction. When in doubt, double a word.
 */
export const ABORT_PHRASES: readonly string[] = [
  'cancel cancel',
  'abort abort',
  'scratch all that',
  'scratch all of that',
  'scratch the whole thing',
  'disregard all that',
  'disregard all of that',
  'forget all that',
  'forget all of that',
  'ignore all of that',
]

/** Lowercase, strip everything that is not a letter/digit/space, collapse runs.
 *  ASR punctuation is a guess, so it must never decide whether this fires. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True when the transcript ENDS with a kill phrase. Never throws; empty input is
 * not an abort (an empty dictation is already a no-op and the caller handles it).
 */
export function isAbortedDictation(text: string): boolean {
  const normalized = normalize(text)
  if (!normalized) return false
  return ABORT_PHRASES.some(phrase => normalized === phrase || normalized.endsWith(` ${phrase}`))
}

/** The one-liner shown in the recorder while the mic is live, so the phrase is
 *  discoverable at the moment it is useful rather than buried in settings. */
export const ABORT_HINT = `say "cancel cancel" to discard`
