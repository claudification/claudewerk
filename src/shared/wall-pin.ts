/**
 * THE PIN, and the one place its name is written down.
 *
 * A pinned epic lives on THE WALL's A8 pane. The pin itself is a frontmatter key
 * on the EPIC'S OWN CARD -- not a panel preference -- because the board is
 * already the source of truth: it survives a broker restart, it is greppable,
 * and an agent can read it without asking the dashboard anything.
 *
 * ACCEPTED COST: pinning mutates a tracked card, and the pin is global rather
 * than per-user. That is the right trade for a single-operator fleet; revisit it
 * the day a second person uses the same board.
 *
 * IT IS A SCALAR BOOLEAN, DELIBERATELY. `frontmatter.ts` parses `[a, b]` into an
 * array and everything else into a string, and the wrapped-list bug
 * (`epic-runner-clobbers-refs`) only bites lists. A boolean cannot be wrapped,
 * so the pin cannot be clobbered -- which is why this must never become a list
 * of pinned things stored on some other card.
 *
 * Shared rather than web-local because BOTH halves need it: the sentinel writes
 * and reads the key, the wall and the board button read it back.
 */

/** The frontmatter key. Board and wall both spell it through this constant. */
export const WALL_PINNED_KEY = 'wall_pinned'

/**
 * Is this card pinned to the wall?
 *
 * Accepts the STRING `'true'` as well as the boolean, because the frontmatter
 * subset keeps bare scalars as strings on read while `serializeFrontmatter`
 * writes a real boolean back. Both spellings are on disk in practice (a
 * hand-edited card versus a button-written one) and they mean the same thing.
 */
export function isWallPinned(meta: Record<string, unknown>): boolean {
  const raw = meta[WALL_PINNED_KEY]
  return raw === true || raw === 'true'
}
