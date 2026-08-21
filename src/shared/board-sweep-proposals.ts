/**
 * THE MORNING REPORT'S PROPOSAL VOCABULARY -- what the board sweep is allowed to
 * suggest, and which suggestions arrive already ticked.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A PROPOSAL IS A SENTENCE, NOT AN ACTION. Nothing in this file, and        ┃
 * ┃  nothing in `board-sweep.ts`, mutates a card. Execution is a separate act, ┃
 * ┃  gated on a human, and lives on the surface card.                          ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * The two invariants are expressed in the TYPES rather than in a runtime guard,
 * because a runtime guard is a thing a future surface can forget to call:
 *
 *   `checked: false`     on `flag-duplicate` and `note-delete-at`. Not "defaults
 *                        to false" -- the literal type means a ticked one cannot
 *                        be CONSTRUCTED, so no code path can produce it.
 *   `executable: false`  on `note-delete-at` alone (F18: nothing is ever
 *                        hard-deleted automatically). Execute must not be able to
 *                        perform this kind AT ALL in v1, which is a stronger claim
 *                        than "it arrives unticked" -- unticked can be ticked.
 *
 * WHY THE TWO FACT-KINDS ARRIVE TICKED. `promote-delivered` and `archive-cold`
 * are computed from facts a human can re-check in one command -- git ancestry and
 * date arithmetic -- and both are REVERSIBLE (a lane is a frontmatter key; move
 * it back). `flag-duplicate` is a model's opinion, and an opinion that arrives
 * pre-approved is an opinion nobody reads.
 */

import type { TaskStatus } from './task-statuses'

/** The four kinds, in the order a reader should meet them. */
export const PROPOSAL_KINDS = ['promote-delivered', 'archive-cold', 'flag-duplicate', 'note-delete-at'] as const

export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

/**
 * D6 -- does this kind arrive ticked. Exported as DATA and not baked only into
 * the constructors below because the surface renders a legend from it: a
 * checkbox list that hard-codes its own defaults is the second copy of this
 * table, and the second copy is the one that goes stale.
 */
export const PROPOSAL_DEFAULT_CHECKED: Readonly<Record<ProposalKind, boolean>> = {
  'promote-delivered': true,
  'archive-cold': true,
  'flag-duplicate': false,
  'note-delete-at': false,
}

interface ProposalBase {
  kind: ProposalKind
  /** The card this is about -- its slug, which is the whole primary key. */
  card: string
  /** Arrives ticked? Always `PROPOSAL_DEFAULT_CHECKED[kind]`; carried per
   *  proposal so a renderer never has to look the rule up. */
  checked: boolean
  /** One line, for the row. Written for a human skimming at 08:00. */
  detail: string
}

/** A promise whose commits are all on main, on a card that is not filed yet. */
export interface PromoteDeliveredProposal extends ProposalBase {
  kind: 'promote-delivered'
  checked: true
  /** The lane it is in now -- the surface renders `open -> done`. */
  from: TaskStatus
  to: 'done'
  /** The commits that back it, straight off the promise's `closes:`. This is the
   *  evidence: a row a human can verify with one `git log`. */
  closes: readonly string[]
}

/** An `inbox` card older than the threshold. Never computed from mtime. */
export interface ArchiveColdProposal extends ProposalBase {
  kind: 'archive-cold'
  checked: true
  from: 'inbox'
  to: 'archived'
  /** The card's immutable `created:`, echoed so the row shows its own workings. */
  created: string
  /** Whole days between `created` and the sweep's clock. */
  ageDays: number
}

/** A model's opinion that two cards overlap. Never ticked, ever. */
export interface FlagDuplicateProposal extends ProposalBase {
  kind: 'flag-duplicate'
  checked: false
  /** The other card in the pair. The proposal is filed against `card`. */
  other: string
  /** 0..1. A SORT KEY for the section, NOT a gate -- nothing filters on it, so a
   *  model that is bad at calibration costs ordering and never costs a row. */
  confidence: number
  /** The model's own words for why these two overlap. */
  reason: string
}

/** A `delete_at:` that has elapsed. SEEN, never executed (F18). */
export interface NoteDeleteAtProposal extends ProposalBase {
  kind: 'note-delete-at'
  checked: false
  /** F18, at the type level: no Execute path can ever be handed one of these
   *  with this field true, because the field has no other inhabitant. */
  executable: false
  /** The marker as written on the card. */
  deleteAt: string
  /** Whole days since it elapsed. */
  elapsedDays: number
}

export type Proposal = PromoteDeliveredProposal | ArchiveColdProposal | FlagDuplicateProposal | NoteDeleteAtProposal

/**
 * May Execute run this proposal at all? THE one answer, for every surface.
 *
 * `checked` says what the box starts as; a human can tick a box. This says the
 * button is not wired, which is a different and stronger statement and the one
 * F18 actually makes. Exported so the surface asks rather than re-deriving
 * "everything except note-delete-at" and drifting when a fifth kind lands.
 */
export function isExecutable(proposal: Pick<Proposal, 'kind'>): boolean {
  return proposal.kind !== 'note-delete-at'
}

export function promoteDelivered(args: {
  card: string
  from: TaskStatus
  closes: readonly string[]
}): PromoteDeliveredProposal {
  const closes = [...args.closes]
  return {
    kind: 'promote-delivered',
    card: args.card,
    checked: true,
    from: args.from,
    to: 'done',
    closes,
    detail: `promise delivered -- ${closes.length} commit(s) on main (${closes.join(', ')}); card is still \`${args.from}\``,
  }
}

export function archiveCold(args: { card: string; created: string; ageDays: number }): ArchiveColdProposal {
  return {
    kind: 'archive-cold',
    card: args.card,
    checked: true,
    from: 'inbox',
    to: 'archived',
    created: args.created,
    ageDays: args.ageDays,
    detail: `filed ${args.ageDays}d ago (${args.created}) and never left \`inbox\``,
  }
}

export function flagDuplicate(args: {
  card: string
  other: string
  confidence: number
  reason: string
}): FlagDuplicateProposal {
  return {
    kind: 'flag-duplicate',
    card: args.card,
    checked: false,
    other: args.other,
    confidence: args.confidence,
    reason: args.reason,
    detail: `may duplicate \`${args.other}\` -- ${args.reason}`,
  }
}

export function noteDeleteAt(args: { card: string; deleteAt: string; elapsedDays: number }): NoteDeleteAtProposal {
  return {
    kind: 'note-delete-at',
    card: args.card,
    checked: false,
    executable: false,
    deleteAt: args.deleteAt,
    elapsedDays: args.elapsedDays,
    detail: `\`delete_at\` elapsed ${args.elapsedDays}d ago (${args.deleteAt}) -- a marker for a human, never executed here`,
  }
}
