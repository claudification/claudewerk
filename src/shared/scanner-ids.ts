/**
 * THE FIVE SCANNER IDS -- named all at once, before four of them exist.
 *
 * A scanner is a standing sweep over the board plus the conversation registry
 * (`src/broker/scanners/scanner.ts` holds the contract). Only `epics` has an
 * implementation today; the other four are carded.
 *
 * WHY ALL FIVE ON DAY ONE. The per-project opt-in reads this union to render its
 * checkboxes, and the morning-report sweep in a different epic reads it too. Four
 * of those cards run CONCURRENTLY in separate worktrees and merge independently,
 * so a union that grew by one line per card would be a guaranteed multi-way
 * conflict on a file none of them owns. Naming the whole set once costs nothing
 * and removes the conflict entirely.
 *
 * In `src/shared` rather than `src/broker` because the opt-in surface is web-side
 * -- a checkbox list cannot import broker internals.
 */

/**
 * Every id, in the order a human should be offered them.
 *
 * The ARRAY is the source and the union is derived from it, rather than the other
 * way round: a caller that needs to iterate the set (an opt-in form, a settings
 * migration) would otherwise hand-copy the union into a second array, and the two
 * would drift the first time a sixth scanner is named.
 */
// No consumer yet BY DESIGN -- the opt-in form that iterates this is a separate
// card, and naming all five ids before their scanners exist is the whole point of
// this file (see the header: it is what stops four concurrent cards conflicting).
// fallow-ignore-next-line unused-export
export const SCANNER_IDS = ['refine', 'nightshift', 'work-orders', 'epics', 'morning-report'] as const

export type ScannerId = (typeof SCANNER_IDS)[number]
