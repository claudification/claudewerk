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
export const SCANNER_IDS = ['refine', 'nightshift', 'work-order', 'epics', 'morning-report'] as const

export type ScannerId = (typeof SCANNER_IDS)[number]

/**
 * THE SPELLINGS THAT ARE NOT THE NAME, and what each one means.
 *
 * SINGULAR IS THE TERM. A scanner id names ONE unit of work the sweep does --
 * "refine a card", "dispatch a work order" -- and `work-orders` was the only id
 * that named a pile instead. It also read wrong everywhere it was quoted next to
 * the artifact it dispatches: `order@1` is singular, `WORK_ORDER_EPIC_ID` is
 * singular, `WorkOrderBucket` is singular, and the id in the middle of them was
 * not.
 *
 * THE PLURAL IS AN ALIAS AND STAYS ONE FOREVER, because it is on disk in two
 * places a rename cannot reach:
 *
 *   1. `settings.scanners['work-orders'] = true` -- every project that ticked
 *      the box before this rename. A read that missed it would silently switch
 *      the scanner OFF for them, which is the one failure mode a default-deny
 *      opt-in cannot distinguish from "never enabled".
 *   2. The launch tag of every already-dispatched seat (`WORK_ORDER_EPIC_ID`).
 *      `isReservedScannerLane` is what stops such a seat being read as a phantom
 *      epic and beaten every 45s forever -- so the predicate has to know the old
 *      word even after nothing writes it.
 *
 * A one-way map, deliberately: aliases resolve TO the canonical id, never back.
 * Nothing may write an alias -- `canonicalizeScannerToggles` (scanner-opt-in)
 * rewrites a stored map the next time it is saved, and the set drains on its own.
 */
const SCANNER_ID_ALIASES: Readonly<Record<string, ScannerId>> = {
  'work-orders': 'work-order',
}

/**
 * The canonical id for any spelling, or `undefined` for a word that is not a
 * scanner at all.
 *
 * `undefined` rather than a throw or a passthrough: both callers are reading
 * data they do not control -- a settings row a human hand-edited, an epic id off
 * a launch tag -- and "not a scanner" is a normal answer there, not an error.
 */
export function canonicalScannerId(raw: string): ScannerId | undefined {
  if ((SCANNER_IDS as readonly string[]).includes(raw)) return raw as ScannerId
  return SCANNER_ID_ALIASES[raw]
}

/**
 * Is this word a scanner id in ANY spelling, current or aliased?
 *
 * Separate from `canonicalScannerId` because the reserved-lane rule
 * (`isReservedScannerLane`) asks a yes/no question about a string that is USUALLY
 * an epic id, and `canonicalScannerId(x) !== undefined` at every such call site
 * is the shape that eventually gets written as `x in SCANNER_IDS` by someone in
 * a hurry -- dropping the aliases, and with them every seat dispatched before
 * this rename.
 */
export function isScannerWord(raw: string): boolean {
  return canonicalScannerId(raw) !== undefined
}
