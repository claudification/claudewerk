/**
 * The one- or two-letter mark an epic wears next to its name.
 *
 * Hue alone cannot carry identity. It fails for a colourblind viewer, it fails
 * once a board has more epics than the 16 hue slots in `epic-color.ts`, and it
 * fails on the rail specifically -- a 2px edge is not enough colour to name a
 * thing by. The mark fixes all three at once: colour and letter say the same
 * word, so either one alone is enough to read it.
 *
 * Derived, never stored, for the same reason the hue is: an epic that existed
 * before this feature must already have a mark, with no migration and no write.
 */

/** The token that says "this is an epic" rather than naming it. Never a mark. */
const NOISE = new Set(['epic', 'the', 'a', 'an'])

function tokenize(epicId: string): string[] {
  return epicId
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .filter(t => !NOISE.has(t.toLowerCase()))
}

/**
 * `spawn-unify-epic` -> `SU`, `anvil-epic` -> `AN`, `x` -> `X`.
 *
 * Two meaningful words give their initials; one word gives its first two
 * letters. Both land on two characters, which is what keeps a column of marks
 * aligned -- a mixed 1/2-character column reads as ragged rather than as a set.
 */
export function epicMark(epicId: string): string {
  const tokens = tokenize(epicId)
  if (tokens.length === 0) return epicId.slice(0, 2).toUpperCase() || '??'
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase()
  return (tokens[0][0] + tokens[1][0]).toUpperCase()
}
