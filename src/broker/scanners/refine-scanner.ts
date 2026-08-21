/**
 * THE REFINE SCANNER -- the consumer for `#needs-refine`, and the only thing on
 * the board allowed to dispatch against a rough card.
 *
 * `quick-task-needs-refine-keypress` puts `needs-refine` on a card with one
 * keypress. Nothing consumed it, so the tag was a label: a queue with no drain,
 * which is the "enabled, last ran never" failure that killed nightshift,
 * scheduled tasks and quests in turn.
 *
 *   reads    the board + the conversation registry
 *   selects  cards tagged `needs-refine`
 *   skips    anything with a live conversation
 *   refuses  into named buckets -- `REFINE_BUCKETS`, and nothing else
 *   does     dispatch a `REFINER@1` seat against the card
 *   is       self-catching (via `runScan`), effects injected, no broker needed
 *
 * THE TAG IS THE QUEUE, AND DRAINING IT IS THE JOB. A refiner that improves a
 * card and leaves the tag on refines that card again on every tick, forever.
 * The removal is an imperative in `REFINER_INSTRUCTIONS` (step 6), which is why
 * this file does not restate it: `refiner-order.ts` is the one definition of
 * what a refiner is, `task-modes.ts` exists because two definitions of "refine"
 * had already diverged once, and a third copy here is exactly that drift.
 *
 * WHAT STOPS AN UNDRAINED TAG BILLING FOREVER is the `already-run` bucket below,
 * not the instruction. A refiner that died before step 6 leaves the card tagged
 * and the seat settled, and from the next tick the card is refused rather than
 * re-dispatched -- so a killed refiner leaves a card tagged and undispatched,
 * never half-refined and never on a retry treadmill.
 *
 * THE OTHER HALF OF THIS CARD IS NOT HERE. "A rough card is not dispatchable by
 * any other scanner" is a PRECONDITION in the readiness fold
 * (`epic-ready.ts`'s `needsRefine` bucket), not an ordering between this scanner
 * and the work one. Stated there it holds whether this scanner ran first, last,
 * concurrently or never.
 *
 * DELIBERATELY DOES NOT USE `planTagged`. Every other selector in the fabric
 * does; this one cannot, because that fold now refuses every `needs-refine` card
 * by construction and folding the drain through it would ask the fold to both
 * withhold the card and hand it over. The consequences are stated where they
 * differ (`deps`, `questions`) rather than inherited by accident.
 *
 * NOT A SCHEDULER, and it does not read settings. The caller owns the clock, the
 * per-project opt-in and the last-run stamp (scanner-opt-in).
 */

import { cardRelPath } from '../../shared/card-path'
import { epicBucket } from '../../shared/epic-cards'
import { NEEDS_REFINE_TAG } from '../../shared/epic-ready'
import type { ProjectTaskMeta } from '../../shared/project-task-types'
import { REFINER, REFINER_INSTRUCTIONS, REFINER_ORDER } from '../../shared/refiner-order'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { buildUnattendedSettings, type UnattendedPermissionConfig } from '../../shared/unattended-permissions'
import { emptyGroup, groupEpicConversations, type ProducedOutput } from '../epic-sweep'
import { applyOrderToRequest } from '../scheduled-tasks/fire'
import {
  DISPATCH_FAILED_BUCKET,
  type DispatchFailedBucket,
  type DispatchUnit,
  dispatchUnits,
  type Refusal,
  type Scanner,
  type ScannerDeps,
  type ScanOutcome,
} from './scanner'

/**
 * THE EPIC ID EVERY REFINER SEAT IS TAGGED WITH -- a reserved lane, not a real
 * epic (`scanner-reserved-lane-phantom-epic`).
 *
 * `groupEpicConversations` is the liveness fold this scanner shares with the
 * epic sweep, and it groups by `launchConfig.epic.epicId` -- so a refiner needs
 * an epic tag whether or not the card it refines belongs to an epic. It is the
 * scanner's own id and DELIBERATELY NOT any real epic's: a seat tagged with a
 * live epic's id would be absorbed into that epic's group, counted as one of its
 * in-flight legs and acknowledged into its baton.
 */
export const REFINE_EPIC_ID = 'refine'

/** Log prefix. Named here because `scanRefine` hands it to the shared dispatch
 *  tail, and the `Scanner` record below quotes the same constant -- two
 *  spellings of a log prefix is how a grep stops finding half the lines. */
const REFINE_TAG = '[refine]'

/**
 * MAX REFINER SEATS IN FLIGHT, quoted from the ORDER rather than picked here.
 *
 * "A backlog of 40 tagged cards must not consume every seat" is the card's own
 * requirement, and `SeatOrder.reservation` is where a role's appetite already
 * lives -- see `seat-reservation.ts`, which enforces the identical number on the
 * scheduler's own pool. Re-picking it here would be the second number that
 * quietly disagrees with the first.
 */
export const DEFAULT_REFINE_CONCURRENCY = REFINER.reservation

/**
 * Every way this scanner can decline a `needs-refine` card. Closed, so a reason
 * it did not declare is a compile error, and countable, so a pane can render the
 * shape of a backlog instead of a log nobody greps.
 *
 * NO `waiting-on-deps` AND NO `needs-overseer` LANE, and both absences are
 * decisions. Refining is not implementing: rewriting a card's prose does not
 * touch its dependencies' work, so a rough card whose dependency is still open
 * is exactly the card most worth making buildable BEFORE that dependency lands.
 * A `needs-overseer` card carrying the tag is likewise still a card whose prose
 * can be improved, and the seat cannot answer the question or move the lane
 * (`REFINER@1` denies the status verb), so there is nothing for it to get wrong.
 */
export type RefineBucket =
  | 'live-conversation'
  | 'already-run'
  | 'not-actionable'
  | 'unspawnable'
  | 'held-back'
  | 'order-refused'
  // Spelled by the shared surface, never restated here -- see
  // `DISPATCH_FAILED_BUCKET`, which is the bucket the shared dispatch tail
  // files into.
  | DispatchFailedBucket

const REFINE_BUCKETS: readonly RefineBucket[] = [
  'live-conversation',
  'already-run',
  'not-actionable',
  'unspawnable',
  'held-back',
  'order-refused',
  DISPATCH_FAILED_BUCKET,
] as const

export interface RefineDeps extends ScannerDeps {
  /** The board for the project being scanned. Async because the board lives
   *  sentinel-side; injected because a scanner does not own an RPC. */
  getCards: () => Promise<readonly ProjectTaskMeta[]>
  /** Did this conversation ever produce a transcript entry? Feeds the shared
   *  failed-launch fold -- see `epic-sweep.ts`, which explains the default. */
  producedOutput: ProducedOutput
  /** Seat ceiling. Defaults to {@link DEFAULT_REFINE_CONCURRENCY} at the call
   *  site; over it, cards land in `held-back` with a count rather than being
   *  silently truncated. */
  concurrency: number
  /** Project URI. Informational to the broker, resolved by the sentinel. */
  project: string
  /** Absolute project root, so the seat can be told which file to edit. */
  projectRoot: string
  /** Per-project extra allow/deny rules layered on the unattended defaults. The
   *  order's own deny rules are unioned on top by `applyOrderToRequest`. */
  permissions?: UnattendedPermissionConfig
  /** Hand a compiled seat to whatever spawns. `false` means the spawn was
   *  refused, and the card is then refused into `dispatch-failed` rather than
   *  counted as acted on -- a dispatch nobody accepted moved nothing. */
  dispatch: (request: SpawnRequest, cardId: string) => Promise<boolean>
}

/** Refuse a whole lane into one bucket, in one line. */
function refuseLane(
  cards: readonly ProjectTaskMeta[],
  bucket: RefineBucket,
  detail: (card: ProjectTaskMeta) => string,
): Refusal<RefineBucket>[] {
  return cards.map(card => ({ unit: card.slug, bucket, detail: detail(card) }))
}

/**
 * `sanitizeConversationName` truncates to this and the spawn gate then refuses a
 * name any conversation has EVER used, ended ones included -- so a name built
 * past this length is not trimmed, it is trimmed into somebody else's.
 */
const NAME_BUDGET = 60

/** A refiner's conversation name: the order's prefix, the card, and the attempt.
 *  The attempt goes at the END because truncation eats from the right, and it is
 *  the only part that makes a second attempt a second name. */
function refinerName(cardId: string, gen: number): string {
  const head = REFINER_ORDER.namePrefix ?? ''
  const suffix = ` g${gen}`
  const room = NAME_BUDGET - head.length - suffix.length
  return `${head}${cardId.slice(0, Math.max(1, room))}${suffix}`
}

/**
 * The prompt: WHICH card, then the order's own instructions verbatim.
 *
 * The instruction block is imported, never restated -- it is the half of the
 * seat that says what refining means, including the tag removal that drains the
 * queue. All this function adds is the pointer, which is the half `REFINER@1`
 * deliberately does not carry ("there is deliberately no dispatcher here").
 */
function buildRefinerPrompt(projectRoot: string, cardId: string): string {
  return [
    `REFINE the board card \`${cardId}\`.`,
    '',
    `Card file: ${projectRoot}/${cardRelPath(cardId)}`,
    '',
    REFINER_INSTRUCTIONS,
  ].join('\n')
}

/** One card's attempt number, used only for the seat NAME, so a re-tagged card
 *  reads as a second attempt rather than colliding with its first. */
function attemptsFor(deps: RefineDeps, cardId: string): number {
  return deps
    .getAllConversations()
    .filter(c => c.launchConfig?.epic?.epicId === REFINE_EPIC_ID && c.launchConfig.epic.cardId === cardId).length
}

/** What a compiled seat is, or why it could not be compiled. */
type SeatCompilation = { ok: true; request: SpawnRequest } | { ok: false; reason: string }

/**
 * CARD + `REFINER@1` -> the seat, through the same function the scheduler uses.
 *
 * `applyOrderToRequest` is what spends an order onto a spawn request: it runs
 * the caps through `composeOrderCaps` (so an order can only ever narrow) and
 * unions the order's deny rules into the fragment. Calling it rather than
 * re-deriving the caps here is what makes a refiner dispatched by this scanner
 * byte-identical to one dispatched by a schedule -- most importantly the deny on
 * `mcp__rclaude__project_set_status`, which is the mechanical half of "a card
 * that got clearer did not get done".
 *
 * The base fragment is `buildUnattendedSettings`, which carries the deny FLOOR
 * (force-push, push to mainline, sudo, kills, external sends) plus the project's
 * own rules. Nobody is watching a refiner, so it gets the floor for the same
 * reason every scheduled fire does.
 */
function compileSeat(deps: RefineDeps, card: ProjectTaskMeta): SeatCompilation {
  const gen = attemptsFor(deps, card.slug)
  const base: SpawnRequest = {
    cwd: deps.project,
    prompt: buildRefinerPrompt(deps.projectRoot, card.slug),
    headless: true,
    // Single-prompt worker: exit at end of turn rather than idling until the
    // watchdog reaps it. Same reasoning as every other unattended seat.
    adHoc: true,
    name: refinerName(card.slug, gen),
    // A seat would rather be renamed than refused -- the generation covers the
    // normal retry, this covers two long card ids truncating onto one name.
    failOnNameCollision: false,
    // NO WORKTREE, and `REFINER@1` declares none: the board lives in the main
    // checkout, so a card refined inside an isolated worktree is a card nobody
    // else sees.
    epic: { epicId: REFINE_EPIC_ID, role: 'implementer', gen, cardId: card.slug },
    settingsInline: buildUnattendedSettings(deps.permissions),
  }
  const applied = applyOrderToRequest(base, REFINER)
  if (!applied.ok) return { ok: false, reason: applied.reason }
  return { ok: true, request: applied.request }
}

/** What the shared liveness fold already knows about this scanner's own lane,
 *  as the three membership tests {@link triageSelected} actually asks. */
interface RefineLiveness {
  live: ReadonlySet<string>
  settled: ReadonlySet<string>
  dead: ReadonlySet<string>
}

/** The SHARED liveness fold, over this scanner's own reserved lane. It answers
 *  in-flight, settled and unspawnable in one pass and the epic sweep uses the
 *  identical one, so the two engines cannot disagree about what is alive. */
function refineGroup(deps: RefineDeps): ReturnType<typeof emptyGroup> {
  return (
    groupEpicConversations(deps.getAllConversations(), deps.isLive, deps.producedOutput).get(REFINE_EPIC_ID) ??
    emptyGroup(REFINE_EPIC_ID, deps.project)
  )
}

/**
 * EVERY WAY A SELECTED CARD IS REFUSED BEFORE THE CEILING, MOST SPECIFIC FIRST
 * -- first rule that claims the card wins, and everything below it is skipped.
 *
 * A table rather than an if-chain, matching `WITHHOLD_RULES` in `epic-ready.ts`
 * and `IDLE_RULES` beside it: THE ORDER IS THE DESIGN, and a table makes that
 * order something you can read, reorder and test rather than something you
 * reconstruct by tracing branches. `lint:patterns` enforces it as a covenant
 * ("no-long-if-chain"), which is how this one got written down.
 *
 * CEILING-FREE ON PURPOSE. A card refused by any rule here never reaches the
 * ceiling, so it never consumes a slot another card could have used.
 */
const REFUSAL_RULES: ReadonlyArray<{
  claims: (card: ProjectTaskMeta, liveness: RefineLiveness) => boolean
  bucket: RefineBucket
  detail: (card: ProjectTaskMeta) => string
}> = [
  {
    // A REFINER REWRITES A CARD NOBODY IS BUILDING YET. `inbox` and `open` are
    // the only lanes where that is true; moving the spec out from under a live
    // implementer, or rewriting a card whose work already shipped, is worse than
    // leaving the tag on. Terminal cards land here too -- a tag left on a `done`
    // card is history, not a queue entry.
    claims: card => epicBucket(card.status) !== 'notStarted',
    bucket: 'not-actionable',
    detail: card =>
      `tagged \`${NEEDS_REFINE_TAG}\` but sitting in \`${card.status}\` -- a refiner rewrites a card nobody is building yet`,
  },
  {
    claims: (card, liveness) => liveness.live.has(card.slug),
    bucket: 'live-conversation',
    detail: () => 'a refiner is already working it',
  },
  {
    claims: (card, liveness) => liveness.dead.has(card.slug),
    bucket: 'unspawnable',
    detail: () => 'refiner seats keep dying before producing anything; not retried',
  },
  {
    // THE BOUND ON THE RETRY PATH, and the reason an undrained tag cannot bill
    // forever. A refiner that ran and finished leaves the tag on only if it
    // failed to reach step 6 of its instructions -- and dispatching a second
    // one, and a third, every tick, is the treadmill. The card stays tagged and
    // visible with a reason instead; re-tagging it (or fixing whatever stopped
    // the drain) re-authorises it, by a decision somebody made, never the clock.
    claims: (card, liveness) => liveness.settled.has(card.slug),
    bucket: 'already-run',
    detail: () => 'a refiner already ran for this card and the tag is still on -- re-tag it to re-authorise',
  },
]

/**
 * WHICH SELECTED CARDS A REFINER MAY BE SENT TO, and a named bucket for every
 * one of the rest.
 *
 * The one place that walks {@link REFUSAL_RULES}. Everything a reader has to
 * audit is in the table; this is the loop that applies it.
 */
function triageSelected(
  selected: readonly ProjectTaskMeta[],
  liveness: RefineLiveness,
): { candidates: ProjectTaskMeta[]; refused: Refusal<RefineBucket>[] } {
  const refused: Refusal<RefineBucket>[] = []
  const candidates: ProjectTaskMeta[] = []
  for (const card of selected) {
    const rule = REFUSAL_RULES.find(r => r.claims(card, liveness))
    if (rule) refused.push({ unit: card.slug, bucket: rule.bucket, detail: rule.detail(card) })
    else candidates.push(card)
  }
  return { candidates, refused }
}

/**
 * COMPILE EVERY SEAT BEFORE ANY OF THEM IS SENT, so the dispatch itself is the
 * shared tail and nothing else.
 *
 * An order that asks for more privilege than this caller holds, or a fragment
 * its deny rules cannot be unioned into, is a REFUSAL and not a quiet downgrade
 * -- dispatching a refiner that regained the status verb looks exactly like a
 * correct run until a card lands in the wrong lane.
 */
function compileSeats(
  deps: RefineDeps,
  cards: readonly ProjectTaskMeta[],
): { units: DispatchUnit[]; refused: Refusal<RefineBucket>[] } {
  const units: DispatchUnit[] = []
  const refused: Refusal<RefineBucket>[] = []
  for (const card of cards) {
    const seat = compileSeat(deps, card)
    if (seat.ok) units.push({ id: card.slug, send: () => deps.dispatch(seat.request, card.slug) })
    else refused.push({ unit: card.slug, bucket: 'order-refused', detail: seat.reason })
  }
  return { units, refused }
}

/**
 * ONE PASS.
 *
 * Order matters: the terminal-lane, liveness and already-run guards all run
 * BEFORE the ceiling, so a card nothing would dispatch never consumes a slot
 * another card could have used.
 */
async function scanRefine(deps: RefineDeps): Promise<ScanOutcome<RefineBucket>> {
  const cards = await deps.getCards()
  const selected = cards.filter(c => c.tags.includes(NEEDS_REFINE_TAG))
  if (selected.length === 0) {
    return { selected: [], acted: [], refused: [], idleReason: `no card carries \`${NEEDS_REFINE_TAG}\`` }
  }

  const group = refineGroup(deps)
  const triaged = triageSelected(selected, {
    live: new Set(group.inFlight),
    settled: new Set(group.settled),
    dead: new Set(group.unspawnable),
  })
  const refused = triaged.refused

  // THE CEILING, counting every live refiner and not just the ones whose card is
  // still in this pass's cohort: a seat mid-refine holds its slot even on the
  // tick after its card lost the tag.
  const slots = Math.max(0, deps.concurrency - group.inFlight.length)
  refused.push(
    ...refuseLane(
      triaged.candidates.slice(slots),
      'held-back',
      () => `rough, but the refiner ceiling (${deps.concurrency}) is full`,
    ),
  )

  const compiled = compileSeats(deps, triaged.candidates.slice(0, slots))
  refused.push(...compiled.refused)

  const acted: string[] = []
  await dispatchUnits(compiled.units, { tag: REFINE_TAG, log: deps.log }, { acted, refused })

  return {
    selected: selected.map(c => c.slug),
    acted,
    refused,
    idleReason: acted.length > 0 ? undefined : idleReason(selected.length, refused),
  }
}

/** Why a pass that selected cards dispatched none of them. Most actionable
 *  first, matching the idle table in `epic-ready.ts`: a ceiling clears itself,
 *  an unspawnable seat never does. */
function idleReason(selectedCount: number, refused: readonly Refusal<RefineBucket>[]): string {
  const count = (bucket: RefineBucket): number => refused.filter(r => r.bucket === bucket).length
  const dead = count('unspawnable')
  if (dead > 0) return `${dead} card(s) whose refiner seats keep dying before producing anything, no longer retried`
  const stale = count('already-run')
  if (stale > 0) return `${stale} card(s) a refiner already ran for, still tagged -- re-tag to re-authorise`
  const held = count('held-back')
  if (held > 0) return `${held} card(s) rough but held back by the refiner ceiling`
  return `${selectedCount} card(s) carry \`${NEEDS_REFINE_TAG}\`, none of them refinable right now`
}

export const refineScanner: Scanner<RefineDeps, RefineBucket> = {
  id: 'refine',
  tag: REFINE_TAG,
  selects: `cards tagged \`${NEEDS_REFINE_TAG}\``,
  does: 'dispatch',
  buckets: REFINE_BUCKETS,
  scan: scanRefine,
}
