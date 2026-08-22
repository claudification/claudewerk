/**
 * WHAT EACH SCANNER ACTUALLY DOES -- declared ONCE, read by the broker's
 * `Scanner` record and by the per-project opt-in checkbox.
 *
 * Every project opts in to every scanner separately, off by default. That
 * constraint is only real if the person ticking the box knows what they are
 * arming, and "Dispatch an authorised card as a work order" does not say that it
 * selects on `ready`, that it refuses a card an epic already owns, or that it
 * spends a werk-worker seat.
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
import { SCANNER_SKIPS, type ScannerSkip } from './scanner-buckets'
import type { ScannerId } from './scanner-ids'
import { WERK_REFINER_ORDER_ID } from './werk-refiner-order'

/** The tag the work-order scanner selects on. Here rather than in the scanner
 *  because the panel names it and cannot import the scanner. */
export const READY_TAG = 'ready'

/** The epic tick, owned here so the panel can state the cadence without either
 *  side inventing the number. `epic-sweep-loop.ts` reads it. */
export const EPIC_SWEEP_INTERVAL_MS = 45_000

/**
 * THE PER-PROJECT SCANNER TICK -- how often `refine` and `work-order` sweep every
 * project that ticked their box. `scanner-clock.ts` reads it.
 *
 * Slower than the epic beat on purpose, and the two are not the same kind of
 * clock. The epic sweep drives a RUN that is already in flight: a beat it misses
 * is a generation somebody is waiting on, so 45s is latency against work that has
 * already been authorised. These two POLL for work nobody has started -- a card
 * somebody tagged `ready` an hour ago does not get worse for waiting another
 * fifteen seconds, and each pass costs a board RPC per opted-in project whether
 * or not anything is tagged.
 */
export const SCANNER_TICK_INTERVAL_MS = 60_000

/**
 * MAX WORK-ORDER SEATS IN FLIGHT PER PROJECT.
 *
 * ONE, deliberately, and it is the number the panel quotes below. Unlike the
 * refine ceiling -- which is quoted off `WERK_REFINER_ORDER.reservation`, because
 * an order that declares its own appetite is the one place that appetite belongs
 * -- `WERK-WORKER@1` declares no reservation, so a number had to be picked. It is
 * picked LOW: this scanner dispatches a full implementation seat, in its own
 * worktree, against any card carrying a tag, on every project that opted in, with
 * nobody watching. One at a time is the conservative reading of a role that never
 * said, it is the concurrency the werk agile loop settled on for its own legs, and
 * being wrong in this direction costs latency rather than money.
 */
export const WORK_ORDER_CONCURRENCY = 1

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
 * `morning-report` is the one row that still says "never", and it says it in the
 * honest direction: it has no implementation at all, so its `cadence` is absent
 * and the panel prints "no caller yet" rather than an interval nothing keeps.
 *
 * `refine` and `work-order` used to say the same thing for a DIFFERENT reason --
 * both were built and tested and invoked by nothing, so an armed checkbox behind
 * either one would never fire. `scanner-clock.ts` is the caller they were missing
 * (`werk-scanner-clock`), which is why both now quote a cadence.
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
    seat: WERK_REFINER_ORDER_ID,
    dispatches: `a ${WERK_REFINER_ORDER_ID} seat that rewrites the card in place`,
    cost: `one ${WERK_REFINER_ORDER_ID} seat per card, bounded by that order's own reservation`,
    verifierFollows: 'no verifier -- the rewritten card is the artifact, and a human reads it',
    cadence: `every ${Math.round(SCANNER_TICK_INTERVAL_MS / 1000)}s`,
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
    seat: EPIC_ORDERS['werk-worker'].id,
    dispatches: `a ${EPIC_ORDERS['werk-worker'].id} seat in its own worktree and branch`,
    cost: `one ${EPIC_ORDERS['werk-worker'].id} seat per card, at most ${WORK_ORDER_CONCURRENCY} in flight per project`,
    verifierFollows: `no ${EPIC_ORDERS['werk-verifier'].id} follows -- a card left in review is refused \`awaiting-verdict\` and waits`,
    cadence: `every ${Math.round(SCANNER_TICK_INTERVAL_MS / 1000)}s`,
    built: true,
  },
  epics: {
    id: 'epics',
    label: 'Epics',
    description: 'The epic sweep -- beat every armed run and dispatch its ready cards',
    selects: 'conversations carrying an epic launch tag, plus every armed run',
    does: 'dispatch',
    skips: SCANNER_SKIPS.epics,
    dispatches: `one beat per epic, spending ${EPIC_ORDERS['werk-planner'].id}, ${EPIC_ORDERS['werk-worker'].id} and ${EPIC_ORDERS['werk-verifier'].id} seats as the run's graph allows`,
    cost: "as many seats as the run's graph and its ceilings allow, per beat",
    verifierFollows: `yes -- ${EPIC_ORDERS['werk-verifier'].id} judges every card a werk-worker moves to review`,
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
