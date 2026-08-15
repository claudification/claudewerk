/**
 * deFluff - strip speech disfluencies from a FINISHED dictation.
 *
 * Deepgram's v1 API takes a `filler_words` param and defaults to dropping them;
 * flux (via Workers AI) hands them straight through, so a dictated sentence
 * arrives as "and, uh, be configured with some authentication". Nobody typed
 * that, and nobody wants to read it back.
 *
 * TWO RULES THIS DELIBERATELY DOES NOT BREAK:
 *
 * 1. NEVER RUN ON A PARTIAL. Words vanishing from under the cursor mid-sentence
 *    makes the live transcript jitter. Callers apply this once, at submit.
 * 2. NEVER DEDUPE REPEATS. "I'm I'm gonna" and "pull, pull at the queue" are how
 *    people actually talk -- the repeat is emphasis or a restart, and collapsing
 *    it silently rewrites what was said. An earlier draft did this; it was cut on
 *    purpose. Do not add it back.
 *
 * Paragraph breaks are structure, not whitespace: a flux turn boundary emits
 * `\n\n` and this only ever consumes SPACES AND TABS, never newlines, so the
 * shape of a long dictation survives.
 */

/**
 * Hesitation noises only. Discourse markers ("like", "you know", "I mean",
 * "basically", "sort of") are NOT in here and should not be added: they carry
 * hedging and emphasis that the speaker meant, and stripping them changes what
 * a sentence claims. "uh" means nothing; "basically" narrows a promise.
 *
 * Each alternative allows a trailing run (`uh+`) so a drawn-out "ummmm" goes too.
 */
const FILLERS = 'uh+|um+|uhm+|erm+|er|mm+|hmm+'

/**
 * A filler plus the punctuation speech-to-text wrapped around it. Deepgram
 * commonly emits ", uh," -- deleting just the word would leave "and, , be", so
 * an adjacent comma on EITHER side comes with it. Horizontal whitespace only:
 * `[ \t]`, never `\s`, which would eat the paragraph breaks.
 */
const FILLER_RUN = new RegExp(String.raw`(?:[ \t]*,)?[ \t]*\b(?:${FILLERS})\b[ \t]*,?`, 'gi')

/** A sentence start: text start, after a paragraph break, or after `.!?` + space. */
const SENTENCE_START = /(^|\n\n|[.!?]["')\]]?[ \t]+)([a-z])/g

/** Same alternatives, unanchored and non-global -- just "is there anything to do". */
const HAS_FILLER = new RegExp(String.raw`\b(?:${FILLERS})\b`, 'i')

export function deFluff(text: string): string {
  if (!text) return text
  // NOTHING TO STRIP -> hand it straight back. Everything below exists to repair
  // damage this function itself does, and the recapitalisation in particular is
  // a rewrite of the user's own text. Running that over a message with no filler
  // in it would quietly "fix" capitalisation nobody asked us to touch.
  if (!HAS_FILLER.test(text)) return text.trim()
  return (
    text
      // Replaced with a SPACE, not '' -- "and, uh, be" must land as "and be",
      // and an empty replacement would fuse it into "andbe".
      .replace(FILLER_RUN, ' ')
      // "you know, uh. Something" leaves a floating "." once the filler goes.
      .replace(/[ \t]+([,.!?;:])/g, '$1')
      // Deleting a filler between two commas can leave ",," / ". ." behind.
      .replace(/([,.!?])(?:[ \t]*\1)+/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      // A sentence that WAS "Uh." is now bare punctuation at the front.
      .replace(/^[ \t]*[,.!?;:]+[ \t]*/, '')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      // BEFORE the recapitalise, not after: removing a leading "uh, " leaves the
      // sentence indented by the space it was replaced with, and `^` then fails
      // to see the first letter at all.
      .trim()
      // Speech-to-text capitalises sentences; deleting a leading "Uh, " exposes a
      // lowercase word where a capital belongs. Known cosmetic edge: an abbreviation
      // like "e.g. the" gets recapitalised too. Dictation spells those out ("for
      // example"), so the trade is worth it.
      .replace(SENTENCE_START, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
  )
}
