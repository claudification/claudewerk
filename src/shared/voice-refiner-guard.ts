/**
 * voice-refiner-guard - the OUTPUT CONTRACT for a refinement pass.
 *
 * THE INCIDENT (2026-08-21). A one-word dictation, `RAW: "Okay."`, went through
 * both refinement steps and came back as:
 *
 *   step 1 -> "Please provide the voice transcript you would like me to analyze."
 *   step 2 -> "Please provide the transcript you would like me to clean."
 *
 * and THAT was sent to the agent as the user's own words. Two independent
 * failures had to line up:
 *
 *   1. The transcript was concatenated onto the end of the instruction with no
 *      delimiter, so a short filler utterance read as an acknowledgement rather
 *      than as content and the model concluded nothing had been supplied.
 *      Fixed structurally in voice-refiner-prompt.ts (the <TRANSCRIPT> envelope).
 *   2. There was NO output contract. `refineTranscript` ended in
 *      `return result || rawText`, and a refusal is not empty -- so it sailed
 *      straight through into the user's message.
 *
 * This file is the answer to (2), and it is deliberately separate from the
 * prompt: prompts are best-effort, a guard is not. Every rejection falls back to
 * the RAW transcript, which is always a safe answer -- the worst case of an
 * over-eager guard is a slightly rough transcript, and the worst case of a
 * missing one is the model's chatter typed into the agent as if Jonas said it.
 * Bias accordingly.
 *
 * Pure string work, no I/O, no settings -- so both the broker and the tests can
 * reason about the contract without a network.
 */

/** Alphanumeric word tokens, lowercased. Punctuation and casing are exactly what
 *  a refinement is ALLOWED to change, so they must not count as divergence. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * Under this many words, refinement is all risk and no reward. "Okay.",
 * "yes do it", "scrap that" carry no disfluencies an LLM can improve, and a
 * short utterance is exactly what a model mistakes for an aside to itself --
 * that is the incident above. Skipping is also free latency on the acks that
 * make up a good share of real dictation.
 */
export const TRIVIAL_TRANSCRIPT_WORDS = 4

export function isTrivialTranscript(raw: string): boolean {
  return words(raw).length < TRIVIAL_TRANSCRIPT_WORDS
}

/**
 * The share of the OUTPUT's words that must have come from the transcript.
 * A refinement is a cleanup: it deletes fillers, fixes spellings and re-punctuates,
 * so the overwhelming majority of what it emits was already in the input. An
 * answer, a refusal or a summary is mostly new words.
 *
 * 0.35 is deliberately slack -- a keyterm-heavy correction pass legitimately
 * rewrites tokens ("psalm tinnell" -> "sentinel"), and we would rather pass a
 * mediocre refinement than reject a good one.
 */
const MIN_WORD_OVERLAP = 0.35

/** Below this fraction of the raw length, the model summarised rather than
 *  cleaned (rule 10 of the recommended prompt). Only meaningful once the
 *  transcript is long enough for the ratio to mean anything. */
const MIN_LENGTH_RATIO = 0.25
const LENGTH_CHECK_MIN_WORDS = 20

/**
 * Assistant-register giveaways. Checked against the OUTPUT and, crucially, only
 * counted when the same pattern does NOT match the RAW input -- "please provide
 * the API key" is a perfectly good dictation, and a guard that ate it would be
 * censoring the user instead of the model.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /\b(please )?provide (me )?(with )?(the|your|a) (transcript|text|voice)/i,
  /\bi (don'?t|do not) see (a|any|the) (transcript|text)/i,
  /\bthere (is|'s) no (transcript|text)\b/i,
  /\bwould like me to (clean|analyz|analys|refine|correct|process)/i,
  /\b(i'?m|i am) (sorry|unable)\b/i,
  /\bi (cannot|can'?t|will not|won'?t) (help|assist|clean|do)\b/i,
  /\bas an? (ai|language model)\b/i,
  /\bhere (is|'s) the (cleaned|corrected|refined|polished)/i,
]

/**
 * Why this refinement must be thrown away, or null to accept it.
 *
 * The string is a LOG LINE, not a user-facing message: nothing here is ever
 * shown to the person dictating, because from their side a rejection is
 * indistinguishable from refinement being off. It has to be readable enough that
 * a future reader can tell a guard misfire from a model misfire without
 * re-running the dictation.
 */
export function refinementRejectReason(raw: string, refined: string): string | null {
  const outWords = words(refined)
  if (outWords.length === 0) return 'output has no words'

  const rawWords = words(raw)
  const rawSet = new Set(rawWords)
  const kept = outWords.filter(w => rawSet.has(w)).length
  const overlap = kept / outWords.length
  if (overlap < MIN_WORD_OVERLAP) {
    const pct = Math.round(overlap * 100)
    return `only ${pct}% of the output's words came from the transcript -- the model answered instead of cleaning`
  }

  const refusal = REFUSAL_PATTERNS.find(p => p.test(refined) && !p.test(raw))
  if (refusal) return `output is assistant chatter, not a transcript (matched ${refusal.source})`

  if (rawWords.length >= LENGTH_CHECK_MIN_WORDS && outWords.length / rawWords.length < MIN_LENGTH_RATIO) {
    return `output kept ${outWords.length} of ${rawWords.length} words -- summarised rather than cleaned`
  }

  return null
}
