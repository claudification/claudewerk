/**
 * THE OPEN REGISTRY of card frontmatter keys -- public surface.
 *
 * The tables live in card-schema-keys.ts; this file assembles them and answers
 * the four questions everything else asks:
 *
 *   - what does this key mean?               `cardKeySpec(key)`
 *   - what order does the store write?       `ORDERED_CARD_KEYS`
 *   - which known keys are not linkage?      `KNOWN_NON_LINKAGE_KEYS`
 *   - which keys are worth missing?          `REQUIRED_CARD_KEYS`
 *
 * OPEN, always. `cardKeySpec` returning undefined is the normal, correct answer
 * for `evidence_something_new` or anything else an agent invents -- the card
 * keeps it, verbatim and unremarked. The registry describes what is KNOWN, never
 * what is ALLOWED; see card-schema-types.ts for the incident behind that.
 */

import { buildCardKeys } from './card-schema-keys'
import type { CardKeySpec } from './card-schema-types'

// Only what callers actually reach for. `CardValueType`, `CardKeyOwner` and
// friends describe the tables, so a table author imports them straight from
// card-schema-types.ts -- re-exporting the whole vocabulary here would just be
// a second door onto the same room.
export { CARD_PRIORITIES } from './card-schema-keys'
export type { CardKeyFinding, CardKeySpec } from './card-schema-types'
export { cardValueProblem } from './card-schema-validate'

/** Every key the board knows, ordered block first. */
export const CARD_KEYS: readonly CardKeySpec[] = buildCardKeys()

const BY_KEY = new Map(CARD_KEYS.map(spec => [spec.key, spec]))

/** The spec for a frontmatter key, or undefined -- which is NOT an error. */
export function cardKeySpec(key: string): CardKeySpec | undefined {
  return BY_KEY.get(key)
}

/**
 * Store-owned keys in render order. THE source for `ORDERED_KEYS` in
 * project-card-file.ts; every other key a card carries is written after these,
 * verbatim, in the order it already had.
 */
export const ORDERED_CARD_KEYS: readonly string[] = CARD_KEYS.filter(s => s.ordered).map(s => s.key)

/**
 * Known keys the linkage registry does NOT own. This is the set a "did you mean
 * a verb?" matcher must never flag: every one of them is declared, so a
 * near-miss guess at `test_cmd` or `evidence_base` would be noise. Suppression
 * by DECLARATION rather than by luck -- the old hand-written `STORE_KEYS` held
 * five names and the gate keys stayed quiet only because no verb happened to be
 * one edit away.
 */
export const KNOWN_NON_LINKAGE_KEYS: readonly string[] = CARD_KEYS.filter(s => !s.linkage).map(s => s.key)

/** Keys whose absence is a finding, carrying the severity + shipped check id. */
export const REQUIRED_CARD_KEYS: readonly CardKeySpec[] = CARD_KEYS.filter(s => s.required)
