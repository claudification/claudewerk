/**
 * WHAT EACH SCANNER ACTUALLY DOES -- declared ONCE, read by the broker's
 * `Scanner` record and by the per-project opt-in checkbox.
 *
 * Every project opts in to every scanner separately, off by default. That
 * constraint is only real if the person ticking the box knows what they are
 * arming, and "Dispatch an authorised card as a work order" does not say that it
 * selects on `ready`, that it refuses a card an epic already owns, or that it
 * spends an implementer seat.
 *
 * WHY HERE AND NOT ON THE `Scanner` RECORD. The records live in
 * `src/broker/scanners/`, and those modules pull in the spawn planner, the board
 * reader and the sweep folds -- a browser bundle cannot have them. So the facts
 * live in `src/shared` (the reason `scanner-ids.ts` already gives) and the
 * broker records QUOTE them: `selects`, `does` and `buckets` on each `Scanner`
 * are read off this table, so the panel and the engine cannot drift apart.
 *
 * NOTHING IS TYPED BY HAND THAT A DECLARATION ALREADY HOLDS. Seat ids come off
 * the `Order` records and tags off their own constants -- a seat is being
 * renamed in a neighbouring worktree as this is written, and hand-written prose
 * would have been wrong within the day.
 */

import { EPIC_ORDERS } from './epic-orders'
import { NEEDS_REFINE_TAG } from './epic-ready'
import { NIGHTSHIFT_TAG } from './nightshift-types'
import { REFINER_ORDER_ID } from './refiner-order'
import { SCANNER_SKIPS, type ScannerSkip } from './scanner-buckets'
import type { ScannerId } from './scanner-ids'

/** The tag the work-order scanner selects on. Here rather than in the scanner
 *  because the panel names it and cannot import the scanner. */
export const READY_TAG = 'ready'

/** The epic tick, owned here so the panel can state the cadence without either
 *  side inventing the number. `epic-sweep-loop.ts` reads it. */
export const EPIC_SWEEP_INTERVAL_MS = 45_000

/** The complete contract for one scanner -- the five facts a human needs before
 *  arming it, plus whether it exists and whether anything calls it. */
export interface ScannerContract {
  id: ScannerId
  /** Row label in the opt-in panel. */
  label: string
  /** The one line under the label. */
  description: string
  /** The board tag it selects on; absent when selection is not tag-driven. */
  tag?: string
  /** The selection phrase the `Scanner` record quotes verbatim. */
  selects: string
  /** The lane a selected card must already be in, when there is one. */
  precondition?: string
  /** Propose (a report a human reads) or dispatch (a seat that spends money). */
  does: 'propose' | 'dispatch'
  /** Every named way it declines a unit it selected. */
  skips: readonly ScannerSkip[]
  /** The seat it spends, by order id. Absent when it dispatches no seat. */
  seat?: string
  /** What it hands over -- the order artifact, or the list it builds. */
  dispatches: string
  /** One line on what a single pass costs. */
  cost: string
  /** Whether a verifier follows the seat this scanner dispatches. */
  verifierFollows: string
  /** What invokes it today. ABSENT MEANS NOTHING DOES, and the panel says so
   *  rather than papering over it with an invented number. */
  cadence?: string
  /** Is there an implementation at all? */
  built: boolean
}

/**
 * THE CONTRACTS, keyed by id.
 *
 * Two different kinds of "never" are stated rather than smoothed over, because
 * they are two different bugs: `morning-report` has no implementation at all,
 * while `refine` and `work-order` are built and tested but nothing calls them
 * yet -- an armed checkbox behind either one would never fire, and only one of
 * those is fixed by writing a scanner.
 */
export const SCANNER_CONTRACTS: Record<ScannerId, ScannerContract> = {
  refine: {
    id: 'refine',
    label: 'Refine',
    description: 'Drain #needs-refine -- turn rough cards into worked specs',
    tag: NEEDS_REFINE_TAG,
    selects: `cards tagged \`${NEEDS_REFINE_TAG}\``,
    precondition: 'sitting in `inbox` or `open`',
    does: 'dispatch',
    skips: SCANNER_SKIPS.refine,
    seat: REFINER_ORDER_ID,
    dispatches: `a ${REFINER_ORDER_ID} seat that rewrites the card in place`,
    cost: `one ${REFINER_ORDER_ID} seat per card, bounded by that order's own reservation`,
    verifierFollows: 'no verifier -- the rewritten card is the artifact, and a human reads it',
    built: true,
  },
  nightshift: {
    id: 'nightshift',
    label: 'Nightshift',
    description: 'Dispatch the nightly batch inside the configured night window',
    tag: NIGHTSHIFT_TAG,
    selects: `cards tagged \`${NIGHTSHIFT_TAG}\``,
    precondition: 'not `done` or `archived`',
    does: 'dispatch',
    skips: SCANNER_SKIPS.nightshift,
    dispatches: "tonight's task list, built fresh from each card's current body",
    cost: "bounded by the night run's own task cap; cards past it are refused `over-cap`",
    verifierFollows: 'no verifier -- the morning report is what reads the result',
    cadence: 'when the night run opens -- the scheduled task, or Run now',
    built: true,
  },
  'work-order': {
    id: 'work-order',
    label: 'Work order',
    description: 'Dispatch an authorised card as a work order',
    tag: READY_TAG,
    selects: `cards tagged \`${READY_TAG}\``,
    precondition: 'sitting in `inbox` or `open`, and not owned by an epic',
    does: 'dispatch',
    skips: SCANNER_SKIPS['work-order'],
    seat: EPIC_ORDERS.implementer.id,
    dispatches: `a ${EPIC_ORDERS.implementer.id} seat in its own worktree and branch`,
    cost: `one ${EPIC_ORDERS.implementer.id} seat per card, bounded by the work-order concurrency ceiling`,
    verifierFollows: `no ${EPIC_ORDERS.verifier.id} follows -- a card left in review is refused \`awaiting-verdict\` and waits`,
    built: true,
  },
  epics: {
    id: 'epics',
    label: 'Epics',
    description: 'The epic sweep -- beat every armed run and dispatch its ready cards',
    selects: 'conversations carrying an epic launch tag, plus every armed run',
    does: 'dispatch',
    skips: SCANNER_SKIPS.epics,
    dispatches: `one beat per epic, spending ${EPIC_ORDERS.planner.id}, ${EPIC_ORDERS.implementer.id} and ${EPIC_ORDERS.verifier.id} seats as the run's graph allows`,
    cost: "as many seats as the run's graph and its ceilings allow, per beat",
    verifierFollows: `yes -- ${EPIC_ORDERS.verifier.id} judges every card an implementer moves to review`,
    cadence: `every ${Math.round(EPIC_SWEEP_INTERVAL_MS / 1000)}s`,
    built: true,
  },
  'morning-report': {
    id: 'morning-report',
    label: 'Morning report',
    description: 'Publish the nightly reconciliation',
    selects: 'nothing yet -- this scanner has no implementation',
    does: 'propose',
    skips: SCANNER_SKIPS['morning-report'],
    dispatches: 'nothing -- it proposes a report for a human to read',
    cost: 'no seat -- it spawns nothing',
    verifierFollows: 'no verifier -- a report is not work',
    built: false,
  },
}
