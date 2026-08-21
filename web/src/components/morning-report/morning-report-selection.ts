/**
 * WHAT IS TICKED -- and, more importantly, what a bulk control is allowed to tick.
 *
 * THE SAFETY PROPERTY THIS FILE EXISTS FOR: a fast Execute can never archive a
 * card on a model's hunch. `flag-duplicate` is an opinion; it arrives unticked
 * and NOTHING but a deliberate click on that row may arm it. "Tick all" operates
 * over the ALREADY-DEFAULTED set -- the rows the sweep itself marked -- so the
 * cheapest possible gesture stays the safe one.
 *
 * The defaults are never restated here. `PROPOSAL_DEFAULT_CHECKED` is D6's table
 * and every proposal already carries its own answer in `checked`; a second copy
 * in the UI is the copy that goes stale when a fifth kind lands.
 *
 * Pure: a `Set` of keys in, a `Set` of keys out. No React, no store, no clock.
 */

import type { Proposal } from '@shared/board-sweep-proposals'
import { isExecutable } from '@shared/board-sweep-proposals'
import type { BoardProposalRef } from '@shared/protocol'

/** A proposal's identity -- (kind, card). The same key the broker matches on. */
export function proposalKey(p: { kind: string; card: string }): string {
  return `${p.kind} ${p.card}`
}

/**
 * May this row have a checkbox at all?
 *
 * `isExecutable` is asked rather than answered locally: F18 says Execute must
 * not be able to perform `note-delete-at` AT ALL, and that rule is keyed on kind
 * in the shared module. Re-deriving "everything except note-delete-at" here is
 * how the surface drifts from the op the day a fifth kind arrives.
 */
export function isTickable(p: Pick<Proposal, 'kind'>): boolean {
  return isExecutable(p)
}

/** The D6 defaults, read off the proposals themselves. */
export function defaultSelection(proposals: readonly Proposal[]): Set<string> {
  return new Set(proposals.filter(p => isTickable(p) && p.checked).map(proposalKey))
}

export function toggle(selection: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selection)
  if (!next.delete(key)) next.add(key)
  return next
}

/**
 * "Tick all" -- a UNION with the defaults, never a replacement.
 *
 * Two halves, both deliberate. It can only ADD rows the sweep already marked, so
 * it cannot arm an unchecked-by-default kind. And it does not clear a duplicate
 * somebody deliberately ticked, because a bulk control that silently undoes a
 * considered choice is its own kind of surprise.
 */
export function tickAll(selection: ReadonlySet<string>, proposals: readonly Proposal[]): Set<string> {
  const next = new Set(selection)
  for (const key of defaultSelection(proposals)) next.add(key)
  return next
}

/** "Untick all" -- unticking is always safe, so this one really is everything. */
export function untickAll(): Set<string> {
  return new Set()
}

/** The ticked rows, as `apply` addresses them, in the report's own order. */
export function tickedRefs(selection: ReadonlySet<string>, proposals: readonly Proposal[]): BoardProposalRef[] {
  return proposals
    .filter(p => isTickable(p) && selection.has(proposalKey(p)))
    .map(p =>
      p.kind === 'flag-duplicate' ? { kind: p.kind, card: p.card, other: p.other } : { kind: p.kind, card: p.card },
    )
}

/** How many rows Execute would act on. Drives the button's own label. */
export function tickedCount(selection: ReadonlySet<string>, proposals: readonly Proposal[]): number {
  return tickedRefs(selection, proposals).length
}
