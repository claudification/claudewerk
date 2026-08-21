/**
 * THE `apply` BOARD OP -- executing the proposals a human ticked.
 *
 * It lives HERE and not on the surface because the sentinel owns card files and
 * the broker may not touch one. Execute sends a list of proposal refs; this
 * performs the writes and reports, per proposal, what actually landed.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  WRITE FIRST, THEN REPORT THE OUTCOME. Never the other way round. A card   ┃
 * ┃  write that fails while the log reads "moved" is the exact class of        ┃
 * ┃  confident-but-untrue record the promise ledger exists to prevent, and     ┃
 * ┃  this is the op with the power to produce it in bulk.                      ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * PER-PROPOSAL OUTCOMES, never one boolean over the batch. "Some of them
 * worked" reported as success is a lie about the ones that did not, and a
 * caller cannot recover which is which from an aggregate.
 *
 * F18 IS ENFORCED BY `isExecutable`, the predicate the fold already exports --
 * not by a second gate written here. `note-delete-at` carries `executable:
 * false` as a LITERAL TYPE, so a hand-crafted wire message with `checked: true`
 * still cannot arm one. A gate reading `checked` would be strictly weaker: a
 * box that starts unticked is a box a human can tick.
 */

import { isExecutable } from '../shared/board-sweep-proposals'
import { updateProjectTask } from '../shared/project-card-write'
import type { ProjectTaskInput } from '../shared/project-task-input'
import type { BoardApplyOutcome, BoardApplyRequest, BoardProposalRef } from '../shared/protocol'
import { reportDateIn } from './board-sweep-report'

/** The patch one proposal kind performs, or why it performs none. */
type Mutation = { ok: true; patch: Partial<ProjectTaskInput> } | { ok: false; error: string }

/**
 * D4's `archived_reason` values, one per executable kind, plus D5's backlink.
 * `actor` is `report-<date>`, so "what happened to this card" is answerable FROM
 * THE CARD without scanning every report ever written.
 *
 * `promote-delivered` CARRIES NEITHER KEY, and that is not an oversight. It
 * moves a card to `done`, which is a working lane, not `archived` --
 * `project-doctor-lifecycle.ts::reasonWithoutArchive` files
 * `lifecycle-reason-not-archived` against exactly that shape, and it is right
 * to: a reason on a live card reads as archived to a grep while the card sits
 * in a lane people work. What promoted it is already recorded in the promise
 * block's `closes:`, which is a stronger record than an actor string -- it names
 * the commits.
 */
function mutationFor(ref: BoardProposalRef, actor: string): Mutation {
  switch (ref.kind) {
    case 'promote-delivered':
      return { ok: true, patch: { status: 'done' } }
    case 'archive-cold':
      return { ok: true, patch: { status: 'archived', archivedReason: 'cold', archivedBy: actor } }
    case 'flag-duplicate':
      if (!ref.other) return { ok: false, error: 'flag-duplicate needs `other` -- it is the pointer it archives against' }
      return {
        ok: true,
        patch: { status: 'archived', archivedReason: `duplicate-of:${ref.other}`, archivedBy: actor },
      }
    default:
      // Unreachable while `isExecutable` gates the caller; kept so a FIFTH
      // proposal kind lands here as a refusal instead of a silent no-op.
      return { ok: false, error: `no mutation is defined for \`${ref.kind}\`` }
  }
}

/** One proposal, start to finish. Throws nothing: a write that blows up is this
 *  card's failure, not the batch's. */
function applyOne(root: string, ref: BoardProposalRef, actor: string): BoardApplyOutcome {
  const base = { kind: ref.kind, card: ref.card }
  if (!isExecutable(ref)) {
    return { ...base, ok: false, error: `\`${ref.kind}\` is never executed here (F18) -- it is a marker for a human` }
  }
  const mutation = mutationFor(ref, actor)
  if (!mutation.ok) return { ...base, ok: false, error: mutation.error }

  try {
    const written = updateProjectTask(root, ref.card, mutation.patch)
    // `null` is "no such card". Reported rather than thrown: one stale id in a
    // report executed an hour late must not cost the other nine their writes.
    if (!written) return { ...base, ok: false, error: 'no such card on this board' }
    // READ BACK from what the write returned, not from the patch we sent. This
    // is the difference between reporting the outcome and reporting the intent.
    return {
      ...base,
      ok: true,
      status: written.status as BoardApplyOutcome['status'],
      archivedReason: written.archivedReason,
    }
  } catch (err) {
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Apply the proposals the caller ticked, and NOTHING else.
 *
 * The board is never re-swept here: a fresh fold would act on cards the human
 * never saw. `proposals` is the whole authority, and every id in it gets
 * exactly one row out, in the order it came in.
 */
export function applyProposals(root: string, req: BoardApplyRequest, nowMs: number): BoardApplyOutcome[] {
  const actor = `report-${req.reportDate ?? reportDateIn(nowMs, req.tz)}`
  return req.proposals.map(ref => applyOne(root, ref, actor))
}
