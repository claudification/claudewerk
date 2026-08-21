/**
 * THE BOARD SWEEP -- the morning report's proposal generator, as a pure fold.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  IT MUTATES NOTHING, IT READS NO FILE, AND IT HAS NO CLOCK OF ITS OWN.    ┃
 * ┃  Cards in, git state in, a typed proposal list out. Every branch below is  ┃
 * ┃  exercised with no broker, no sentinel, no filesystem and no CC process.   ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * It lives in `src/shared/` beside `promise-ledger.ts` and `epic-ready.ts` for
 * the reason all three are here: a fold the caller feeds is a fold anyone can
 * test, and the broker is forbidden from reaching for a card at all (CWD IS
 * INFORMATIONAL, `lint:boundary` Rule 4). The sentinel handler that reads the
 * cards off disk and the scheduled task that invokes it are a separate card.
 *
 * BUILT ON THE SCANNER CONTRACT (`src/broker/scanners/scanner.ts`), which this
 * is the fifth implementation of. The types are imported TYPE-ONLY and nothing
 * here calls into the broker, so `src/shared` keeps its no-runtime-broker
 * property while still being checked against the one shape all five sweeps have.
 * The refusal vocabulary below is that contract's requirement: a selected card
 * that produced no proposal says WHY, in a bucket something can count.
 *
 * FOUR RULES THAT LOOK LIKE DETAILS AND ARE NOT
 *
 * 1. AGE COMES FROM `created`, NEVER `mtime`. `setProjectTaskStatus` calls
 *    `utimesSync(now)` on every lane change and any write at all bumps mtime, so
 *    a refiner -- or this sweep's own executed proposals -- would rejuvenate
 *    exactly the cards it exists to find. `created` is immutable.
 * 2. A MISSING `created` IS UNKNOWN, NEVER OLD. It reaches us as `''` (see
 *    `toProjectTask`), and coercing that to epoch 0 would propose archiving the
 *    entire pre-ledger board on the first run.
 * 3. `inbox` ONLY, for cold. That lane carries "never promoted" by itself; `open`
 *    and `in-progress` need a `status_changed_at` nobody writes yet, and judging
 *    them on `created` alone would flag the freshest work on the board.
 * 4. NEVER PROPOSE AGAINST A CARD WITH A LIVE CONVERSATION. Same rule the epic
 *    sweep uses: a card being worked is left alone, whatever the dates say.
 */

import type { Refusal, Scanner, ScannerDeps, ScanOutcome } from '../broker/scanners/scanner'
import {
  type DuplicateCandidate,
  type DuplicateJudge,
  type DuplicateJudgement,
  MAX_DUPLICATE_PAIRS,
  shortlistDuplicates,
} from './board-sweep-duplicates'
import {
  archiveCold,
  flagDuplicate,
  noteDeleteAt,
  PROPOSAL_KINDS,
  type Proposal,
  promoteDelivered,
} from './board-sweep-proposals'
import type { ProjectTaskMeta } from './project-task-types'
import { isFiledLane, type PromiseRow } from './promise-ledger'

/**
 * A card, as this fold needs it -- the board's own wire shape, unwidened.
 *
 * `ProjectTaskMeta` already carries every key this sweep reads, `deleteAt`
 * included: `card-doctor-lifecycle-keys` put the three lifecycle keys on the wire
 * and validates them at write time. An alias rather than an extension on purpose
 * -- a `SweepCard extends ProjectTaskMeta { deleteAt?: string }` written here
 * would be a second, unvalidated declaration of a key the board already owns.
 */
export type SweepCard = ProjectTaskMeta

/** Every way this sweep can decline to propose against a card it looked at. */
export type BoardSweepBucket =
  /** Rule 4 -- the card is being worked right now. */
  | 'live-conversation'
  /** A delivered promise on a card already in `done`/`archived`. Nothing to do,
   *  and the loudest possible non-event: it means the ledger AGREES with the board. */
  | 'already-filed'
  /** Rule 2 -- no readable `created:`, so its age is unknown and never "old". */
  | 'created-unknown'
  /** An `inbox` card younger than the threshold. */
  | 'not-cold-yet'
  /** `delete_at` is in the future. Correct, and the normal state of the key. */
  | 'delete-at-pending'
  /** `delete_at` is present and not a date. A defect, reported not guessed at. */
  | 'delete-at-unreadable'
  /** The model looked at the pair and said no. */
  | 'not-duplicate'
  /** No `judgeDuplicates` was injected -- the duplicate half did not run at all. */
  | 'no-duplicate-judge'
  /** The judge threw. NEVER folded into `not-duplicate`: "I could not check" is
   *  not "they are different", and the two-fact half of the sweep still shipped. */
  | 'duplicate-judge-failed'
  /** The shortlist cap ate this pair before the model saw it. */
  | 'shortlist-capped'

const BOARD_SWEEP_BUCKETS: readonly BoardSweepBucket[] = [
  'live-conversation',
  'already-filed',
  'created-unknown',
  'not-cold-yet',
  'delete-at-pending',
  'delete-at-unreadable',
  'not-duplicate',
  'no-duplicate-judge',
  'duplicate-judge-failed',
  'shortlist-capped',
] as const

/** Thirty days, and the number is the point of the knob: a threshold nobody can
 *  move is a threshold that gets argued about instead of tuned. */
export const DEFAULT_COLD_AFTER_DAYS = 30

const DAY_MS = 86_400_000

export interface BoardSweepDeps extends ScannerDeps {
  /** The whole board. The caller reads the files; this fold never does. */
  getCards: () => readonly SweepCard[]
  /**
   * Promises already resolved against git, straight from `promise-ledger.ts`.
   * Resolved by the CALLER because answering "is this sha an ancestor of main"
   * means shelling out to git, which neither `src/shared` nor the broker may do.
   */
  getPromises: () => readonly PromiseRow[]
  /** `git rev-parse HEAD`, verbatim. Half of the short-circuit snapshot. */
  head: () => string
  /** The snapshot the previous sweep returned, or null if there was none. */
  lastSnapshot: () => string | null
  /** The model pass. Absent = the duplicate half is reported as not-run. */
  judgeDuplicates?: DuplicateJudge
  /** Override for `DEFAULT_COLD_AFTER_DAYS`. */
  coldAfterDays?: number
}

export interface BoardSweepOutcome extends ScanOutcome<BoardSweepBucket> {
  /** What the human is shown. Ordered by kind, then by card. */
  proposals: readonly Proposal[]
  /** `(HEAD, card count, max card mtime)`. Hand it back next time as
   *  `lastSnapshot` and an unchanged board costs nothing. */
  snapshot: string
  /** The short-circuit fired -- nothing was computed, on purpose. */
  skipped: boolean
}

/**
 * The board's identity for short-circuit purposes.
 *
 * A composed string rather than a digest: it is only ever compared for equality,
 * and when it does not match, a human wants to see WHICH of the three parts
 * moved. Card COUNT is in there because a deletion moves no surviving card's
 * mtime, and a board that lost a card is not the board we swept.
 *
 * ORDERING CONSEQUENCE, worth knowing before you wire a schedule: refinement
 * edits cards, so a refine pass must run BEFORE this snapshot is taken or the
 * short-circuit never fires.
 */
export function boardSnapshot(head: string, cards: readonly ProjectTaskMeta[]): string {
  let maxMtime = 0
  for (const card of cards) maxMtime = Math.max(maxMtime, card.mtime)
  return `${head}:${cards.length}:${maxMtime}`
}

/**
 * Cards with a conversation still alive on them.
 *
 * The only structured card <-> conversation link in this codebase is an epic
 * seat's `launchConfig.epic.cardId`, and the OR-fold across seats is the subtle
 * part: a card retried after a crash has two conversations, and the dead
 * predecessor must not make the live retry look finished. `epic-sweep.ts` folds
 * the same thing per epic and cannot be imported here (it is broker code and this
 * is `src/shared`), so this is the board-wide version -- deliberately the same
 * rule, deliberately not the same scope.
 */
export function cardsBeingWorked(deps: Pick<ScannerDeps, 'getAllConversations' | 'isLive'>): Set<string> {
  const live = new Set<string>()
  for (const conv of deps.getAllConversations()) {
    const cardId = conv.launchConfig?.epic?.cardId
    if (cardId && deps.isLive(conv)) live.add(cardId)
  }
  return live
}

/** Whole days between `iso` and `now`, or null when the string is not a date.
 *  Null is the honest answer for `''` -- see rule 2 in the header. */
export function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso || iso.trim() === '') return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  return Math.floor((now - at) / DAY_MS)
}

/** One card's worth of the pass: the proposals it earned and the reasons it did
 *  not. `acted` wins over `refused` at the end, so a card never counts twice. */
interface CardVerdicts {
  proposals: Proposal[]
  refusals: Refusal<BoardSweepBucket>[]
}

function promoteVerdicts(card: SweepCard, row: PromiseRow, out: CardVerdicts): void {
  if (isFiledLane(card.status)) {
    out.refusals.push({
      unit: card.slug,
      bucket: 'already-filed',
      detail: `promise is delivered and the card is already \`${card.status}\` -- the ledger and the board agree`,
    })
    return
  }
  out.proposals.push(promoteDelivered({ card: card.slug, from: card.status, closes: row.closes }))
}

function coldVerdicts(card: SweepCard, now: number, coldAfterDays: number, out: CardVerdicts): void {
  const age = daysSince(card.created, now)
  if (age === null) {
    out.refusals.push({
      unit: card.slug,
      bucket: 'created-unknown',
      detail: card.created ? `\`created: ${card.created}\` is not a date` : 'no `created:` -- age unknown, never old',
    })
    return
  }
  if (age < coldAfterDays) {
    out.refusals.push({
      unit: card.slug,
      bucket: 'not-cold-yet',
      detail: `${age}d old, threshold is ${coldAfterDays}d`,
    })
    return
  }
  out.proposals.push(archiveCold({ card: card.slug, created: card.created, ageDays: age }))
}

function deleteAtVerdicts(card: SweepCard, deleteAt: string, now: number, out: CardVerdicts): void {
  const elapsed = daysSince(deleteAt, now)
  if (elapsed === null) {
    out.refusals.push({
      unit: card.slug,
      bucket: 'delete-at-unreadable',
      detail: `\`delete_at: ${deleteAt}\` is not a date`,
    })
    return
  }
  if (elapsed < 0) {
    out.refusals.push({
      unit: card.slug,
      bucket: 'delete-at-pending',
      detail: `\`delete_at: ${deleteAt}\` is ${-elapsed}d away`,
    })
    return
  }
  out.proposals.push(noteDeleteAt({ card: card.slug, deleteAt, elapsedDays: elapsed }))
}

/** Run the injected judge, or say why the duplicate half produced nothing.
 *  Self-catching: a model outage must not cost the two fact-kinds. */
async function judge(
  deps: BoardSweepDeps,
  shortlist: readonly DuplicateCandidate[],
): Promise<{ judgements: readonly DuplicateJudgement[]; failure?: { bucket: BoardSweepBucket; detail: string } }> {
  if (shortlist.length === 0) return { judgements: [] }
  if (!deps.judgeDuplicates) {
    return {
      judgements: [],
      failure: { bucket: 'no-duplicate-judge', detail: 'no duplicate judge wired -- the model pass did not run' },
    }
  }
  try {
    return { judgements: await deps.judgeDuplicates(shortlist) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    deps.log(`[board-sweep] duplicate judge failed -- the two fact-kinds still shipped: ${detail}`)
    return { judgements: [], failure: { bucket: 'duplicate-judge-failed', detail } }
  }
}

/** Judgements keyed by pair identity, so a judge that reorders or invents a pair
 *  cannot silently rename someone else's verdict. */
function judgementFor(
  judgements: readonly DuplicateJudgement[],
  pair: DuplicateCandidate,
): DuplicateJudgement | undefined {
  return judgements.find(j => (j.a === pair.a && j.b === pair.b) || (j.a === pair.b && j.b === pair.a))
}

const KIND_ORDER = new Map(PROPOSAL_KINDS.map((kind, i) => [kind, i]))

/** Kind order first, then confidence (duplicates only), then card. Deterministic
 *  because the report is diffed against yesterday's by a human. */
function sortProposals(proposals: Proposal[]): Proposal[] {
  return proposals.sort((a, b) => {
    const byKind = (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0)
    if (byKind !== 0) return byKind
    if (a.kind === 'flag-duplicate' && b.kind === 'flag-duplicate' && a.confidence !== b.confidence) {
      return b.confidence - a.confidence
    }
    return a.card.localeCompare(b.card)
  })
}

/**
 * ONE SWEEP.
 *
 * Selection is the CANDIDATE set, not the whole board: a card is selected when it
 * could plausibly yield a proposal (a delivered promise, an `inbox` lane, a
 * `delete_at`, a shortlisted duplicate pair). Selecting all ~600 cards would make
 * the refusal list a per-card census of a board that is mostly finished, and a
 * denominator nobody reads is a denominator that hides the one card that matters.
 */
export async function sweepBoard(deps: BoardSweepDeps): Promise<BoardSweepOutcome> {
  const cards = deps.getCards()
  const snapshot = boardSnapshot(deps.head(), cards)
  const previous = deps.lastSnapshot()
  if (previous !== null && previous === snapshot) {
    // The whole result is a pure function of (cards, git). Nothing moved, so the
    // answer cannot have moved either -- and saying so is cheaper than proving it.
    return {
      selected: [],
      acted: [],
      refused: [],
      proposals: [],
      snapshot,
      skipped: true,
      idleReason: `nothing moved -- HEAD and the board are unchanged since ${snapshot}`,
    }
  }

  const now = deps.now()
  const coldAfterDays = deps.coldAfterDays ?? DEFAULT_COLD_AFTER_DAYS
  const live = cardsBeingWorked(deps)
  const bySlug = new Map(cards.map(card => [card.slug, card]))
  const verdicts = new Map<string, CardVerdicts>()

  const consider = (slug: string): CardVerdicts | null => {
    // Rule 4 is checked BEFORE the memo, not inside it. Checking it only on a
    // card's first consideration would leave a live card open to a proposal from
    // the second kind that looked at it, which is the exact bug the rule exists
    // to prevent -- and it needs three signals on one card to reproduce.
    if (live.has(slug)) {
      if (!verdicts.has(slug)) {
        verdicts.set(slug, {
          proposals: [],
          refusals: [{ unit: slug, bucket: 'live-conversation', detail: 'a conversation is working this card' }],
        })
      }
      return null
    }
    const existing = verdicts.get(slug)
    if (existing) return existing
    const fresh: CardVerdicts = { proposals: [], refusals: [] }
    verdicts.set(slug, fresh)
    return fresh
  }

  // -- promote-delivered. Keyed off the ledger, and only rows whose card is still
  //    on the board: a promise naming a card nobody can find is a ledger defect,
  //    which `closedWithoutCommit` reports and this sweep must not re-report.
  for (const row of deps.getPromises()) {
    if (row.verdict !== 'delivered') continue
    const card = bySlug.get(row.id)
    if (!card) continue
    const out = consider(card.slug)
    if (out) promoteVerdicts(card, row, out)
  }

  // -- archive-cold and note-delete-at, both straight date arithmetic.
  for (const card of cards) {
    if (card.status === 'inbox') {
      const out = consider(card.slug)
      if (out) coldVerdicts(card, now, coldAfterDays, out)
    }
    if (card.deleteAt) {
      const out = consider(card.slug)
      if (out) deleteAtVerdicts(card, card.deleteAt, now, out)
    }
  }

  // -- flag-duplicate. Prefilter, cap, then the model on what survives.
  const { pairs, overflow } = shortlistDuplicates(cards, MAX_DUPLICATE_PAIRS)
  const { judgements, failure } = await judge(deps, pairs)
  for (const pair of pairs) {
    const verdict = judgementFor(judgements, pair)
    for (const slug of [pair.a, pair.b]) {
      const out = consider(slug)
      if (!out) continue
      if (failure) {
        out.refusals.push({
          unit: slug,
          bucket: failure.bucket,
          detail: `${failure.detail} (pair ${pair.a}/${pair.b})`,
        })
        continue
      }
      if (!verdict?.duplicate) {
        out.refusals.push({
          unit: slug,
          bucket: 'not-duplicate',
          detail: verdict
            ? `judged distinct from ${otherOf(pair, slug)}`
            : `no verdict returned for ${pair.a}/${pair.b}`,
        })
        continue
      }
      out.proposals.push(
        flagDuplicate({
          card: slug,
          other: otherOf(pair, slug),
          confidence: verdict.confidence,
          reason: verdict.reason,
        }),
      )
    }
  }
  for (const pair of overflow) {
    for (const slug of [pair.a, pair.b]) {
      const out = consider(slug)
      out?.refusals.push({
        unit: slug,
        bucket: 'shortlist-capped',
        detail: `pair ${pair.a}/${pair.b} scored ${pair.score.toFixed(2)}, below the top ${MAX_DUPLICATE_PAIRS}`,
      })
    }
  }

  const proposals: Proposal[] = []
  const acted: string[] = []
  const refused: Refusal<BoardSweepBucket>[] = []
  for (const [slug, verdict] of verdicts) {
    if (verdict.proposals.length > 0) {
      // Acted WINS. A card that earned a proposal is not also a refusal, or a
      // pane counting both would report more units than the sweep ever selected.
      proposals.push(...verdict.proposals)
      acted.push(slug)
      continue
    }
    refused.push(...verdict.refusals)
  }

  return {
    selected: [...verdicts.keys()].sort(),
    acted: acted.sort(),
    refused,
    proposals: sortProposals(proposals),
    snapshot,
    skipped: false,
    idleReason: idleReason(verdicts.size, acted.length),
  }
}

function otherOf(pair: DuplicateCandidate, slug: string): string {
  return pair.a === slug ? pair.b : pair.a
}

function idleReason(selected: number, acted: number): string | undefined {
  if (acted > 0) return undefined
  if (selected === 0) return 'no card on the board is a candidate for any proposal kind'
  return `${selected} candidate card(s) considered, none earned a proposal`
}

/**
 * The scanner binding. Types only -- nothing in `src/shared` calls the broker,
 * and this object exists so the sweep is checked against the contract instead of
 * merely resembling it.
 */
// The fabric's registry that iterates the scanners is a separate card; this
// binding is the contract conformance, and is consumed by the wiring card.
// fallow-ignore-next-line unused-export
export const boardSweepScanner: Scanner<BoardSweepDeps, BoardSweepBucket> = {
  id: 'morning-report',
  tag: '[board-sweep]',
  selects:
    'every card that could yield a proposal -- a delivered promise, an `inbox` lane, a `delete_at`, a near-duplicate title',
  does: 'propose',
  buckets: BOARD_SWEEP_BUCKETS,
  scan: sweepBoard,
}
