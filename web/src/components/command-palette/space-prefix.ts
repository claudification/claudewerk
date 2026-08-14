/**
 * Double-space gesture: swap the palette between search and command mode
 * without reaching for `>`.
 *
 * On a phone `>` is buried behind the symbols keyboard, while the spacebar is
 * the biggest key on screen. Two spaces typed into an otherwise-empty input
 * therefore mean "give me command mode"; two more typed before anything else
 * mean "take me back to search". A filter that is nothing but whitespace has
 * no meaning in either mode, so the gesture shadows nothing real.
 *
 * Read off the VALUE, not keydown: soft keyboards lie about key events (Android
 * IMEs report keyCode 229 / "Unidentified" for ordinary typing), so the
 * committed text is the only signal every keyboard agrees on. The cost is that
 * iOS smart punctuation rewrites the second space as a period first - hence the
 * character class below rather than a literal `'  '`, so any spelling of the
 * gesture the OS invents still counts.
 */

/** What command mode looks like once the gesture fires: `>` plus breathing room. */
const COMMAND_FILTER = '> '

/** Command-mode prefix, per `derivePaletteMode`. */
const COMMAND_PREFIX = '>'

/** Two or more taps of a spacebar, however the OS chose to spell them. */
const DOUBLE_SPACE = /^[ .]{2,}$/

/**
 * Maps a raw input value to the filter the gesture asks for, or `null` when
 * this is ordinary typing that should be taken verbatim.
 */
export function applyDoubleSpaceGesture(next: string): string | null {
  const inCommandMode = next.startsWith(COMMAND_PREFIX)
  const rest = inCommandMode ? next.slice(COMMAND_PREFIX.length) : next

  if (!DOUBLE_SPACE.test(rest)) return null
  return inCommandMode ? '' : COMMAND_FILTER
}
