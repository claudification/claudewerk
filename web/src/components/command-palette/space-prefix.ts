/**
 * Double-space gesture: swap the palette between search and command mode
 * without reaching for `>`.
 *
 * On a phone `>` is buried behind the symbols keyboard, while the spacebar is
 * the biggest key on screen. Two spaces typed into an otherwise-empty input
 * therefore mean "give me command mode"; two spaces typed straight after the
 * `>` mean "take me back to search". A filter that is nothing but whitespace
 * has no meaning in either mode, so the gesture shadows nothing real.
 *
 * iOS smart punctuation can rewrite that second space as `. ` even with
 * autocorrect off, so both spellings count as the same gesture.
 */

/** Command-mode prefix, per `derivePaletteMode`. */
const COMMAND_PREFIX = '>'

/** Every way a keyboard can spell "the user hit space twice". */
const DOUBLE_SPACE = ['  ', '. ']

/**
 * Maps a raw input value to the filter the gesture asks for, or `null` when
 * this is ordinary typing that should be taken verbatim.
 */
export function applyDoubleSpaceGesture(next: string): string | null {
  if (DOUBLE_SPACE.includes(next)) return COMMAND_PREFIX
  if (DOUBLE_SPACE.some(space => next === COMMAND_PREFIX + space)) return ''
  return null
}
