/**
 * THE DRAIN -- a scanner's tag comes off because the WORK LANDED, never because
 * the seat exited.
 *
 * Every tag-driven scanner has the same queue problem and, until this file, two
 * different wrong answers to it:
 *
 *   `needs-refine`  the removal was step 7 of the werk-refiner's own PROMPT. A seat
 *                   that died at step 6 left the tag on forever, and the
 *                   `already-run` bucket then refused the card every tick -- so it
 *                   sat tagged, undispatched and unworked.
 *   `nightshift`    the removal happened at DISPATCH. A worker that crashed left
 *                   the card UNTAGGED, unworked and invisible: the queue entry was
 *                   gone and nothing on the board said the work never happened.
 *
 * Those two failures are not symmetric and the second is the worse one. A stuck
 * tag is a card you can still see; a cleared tag on unworked work is SILENT SCOPE
 * LOSS. So the rule is written to fail towards the visible failure:
 *
 *   THE ENGINE CLEARS THE TAG, AND ONLY ON EVIDENCE THE WORK HAPPENED.
 *
 * WHY {@link decideTagClear} NEEDS BOTH HALVES. "A seat ran" alone
 * is clear-on-exit, which is the failure above. "The work landed" alone would let
 * the engine strip a tag a human applied thirty seconds ago to a card they then
 * edited -- the engine would be draining a queue nobody had served. Requiring
 * both says the only sentence worth acting on: a seat was sent, and the thing it
 * was sent to do is now true.
 *
 * WHAT "THE WORK LANDED" IS, IS PER TAG, and it has to be -- the seats do
 * different jobs and two of them cannot even move a card's status:
 *
 *   `needs-refine`  the CARD FILE CHANGED after the seat started. `WERK-REFINER@1`
 *                   is denied `project_set_status` on purpose ("a card that got
 *                   clearer did not get done"), so a status advance is precisely
 *                   the evidence a werk-refiner can never produce. See
 *                   `refine-drain.ts`.
 *   `nightshift`    the run's task reached `done`. A night worker commits to a
 *                   branch and reports a verdict; it never touches the card
 *                   either. See `nightshift-orchestrator.ts`.
 *
 * TWO TAGS IN THE CARD'S "APPLIES TO" ARE DELIBERATELY ABSENT HERE.
 * `needs-verification` and `needs-retrospect` are DECLARED AND INERT in
 * `board-system-tags.ts` -- no scanner selects them, nothing dispatches a seat
 * against them, and `werk-verify-by-tag` / `werk-retrospect-hook` are the cards
 * that bring the behaviour. A row for either one would have to invent an evidence
 * predicate for a seat nobody has written, and an evidence rule that is a guess
 * is the one thing this file must not ship: it would clear a hand-applied tag on
 * a fact that means nothing. Their scanner's card brings its drain with it, the
 * way this one did.
 *
 * NOT A SCHEDULER AND NOT A SCANNER. This is the CALLER's half -- the loop that
 * owns the cadence, the opt-in and the last-run stamp is the loop that owns the
 * drain (`scanner-clock.ts`, `nightshift-orchestrator.ts`). `src/broker/scanners/`
 * imports nothing from here.
 */

import type { ProjectTaskMeta } from '../shared/project-task-types'
import { type CallBoard, readBoardCard } from './board-cards'
import type { ConversationStore } from './conversation-store'

/**
 * What the engine knows about one tagged card, at the moment it decides.
 *
 * Four booleans and no card, no clock and no scanner: the RULE is the part every
 * drain shares, and the part worth pinning on its own. Turning a card and a
 * conversation registry into these four is each tag's own job.
 */
export interface TagClearInput {
  /** The card still carries the tag. */
  tagged: boolean
  /** A seat dispatched against this card is still working. */
  seatLive: boolean
  /** A seat dispatched against this card has run AND ended. */
  seatSettled: boolean
  /** THE EVIDENCE: the thing that seat was sent to do is now true. */
  workLanded: boolean
}

/**
 * Why a tagged card kept its tag. NAMED, not a boolean, for the scanner
 * contract's reason: a unit the engine looked at and did nothing about must
 * never vanish quietly, and `no-evidence` (the killed seat) and `no-seat-ran`
 * (nobody has tried yet) are the two a human reads completely differently.
 */
export type TagKeptReason = 'not-tagged' | 'seat-still-running' | 'no-seat-ran' | 'no-evidence'

export type TagClearVerdict = { clear: true } | { clear: false; reason: TagKeptReason }

/**
 * THE RULE, in the order the checks have to run.
 *
 * `seat-still-running` sits ABOVE the evidence test on purpose. A werk-refiner that
 * has already rewritten the card and is still going would satisfy the evidence
 * this tick, and clearing under a live seat buys one tick of earliness in
 * exchange for a card that is untagged while something is still writing to it.
 * The next tick after it exits clears it, which is 45 seconds later and a fact
 * rather than a race.
 */
export function decideTagClear(input: TagClearInput): TagClearVerdict {
  if (!input.tagged) return { clear: false, reason: 'not-tagged' }
  if (input.seatLive) return { clear: false, reason: 'seat-still-running' }
  if (!input.seatSettled) return { clear: false, reason: 'no-seat-ran' }
  // THE WHOLE CARD. A seat that exited without landing its work leaves the tag
  // ON -- the card stays visible and re-tagging (or fixing whatever killed the
  // seat) is a decision somebody makes, never the clock.
  if (!input.workLanded) return { clear: false, reason: 'no-evidence' }
  return { clear: true }
}

/**
 * DROP ONE TAG FROM ONE CARD. The only write in the drain.
 *
 * Re-reads the card first rather than patching a remembered tag list: minutes can
 * pass between the scan that selected it and this write, and clobbering a tag
 * somebody added in between would be a silent edit to their card. A card that
 * already lost the tag is `true` -- the queue entry is gone, which is what the
 * caller asked for.
 *
 * This used to be `untagBoardCard` in `nightshift-board.ts`, hard-coded to
 * `#nightshift` because nightshift was the only scanner that cleared anything.
 * It moved here rather than growing a `tag` parameter in place: the file it lived
 * in is the NIGHT RUN's board door, and `refine`'s clock has no business reaching
 * through nightshift for a write both of them make.
 */
export async function clearCardTag(
  call: CallBoard,
  store: ConversationStore,
  project: string,
  slug: string,
  tag: string,
): Promise<boolean> {
  const card = await readBoardCard(call, store, project, slug)
  if (!card) return false
  if (!card.tags.includes(tag)) return true
  const res = await call(store, project, {
    op: 'update',
    slug,
    patch: { tags: card.tags.filter(t => t !== tag) },
  })
  return !!res.ok
}

/** What one drain pass did, in the scanner contract's shape: every card it
 *  looked at is either cleared, kept with a NAMED reason, or failed to write. */
export interface DrainReport {
  cleared: string[]
  kept: Array<{ slug: string; reason: TagKeptReason }>
  /** The card earned its clear and the board refused the write. Logged loudly:
   *  the tag is still on, so the next pass tries again, but a board that will not
   *  take writes is not a quiet condition. */
  failed: string[]
}

/** The effects one drain pass needs. Injected, so the pass is exercised without
 *  a sentinel, a settings store or a conversation registry. */
export interface DrainDeps {
  /** Every card on the board. The drain does its own tag filter -- a card that
   *  lost the tag between the scan and here is simply not its business. */
  cards: readonly ProjectTaskMeta[]
  /** Turn one card into the four facts {@link decideTagClear} asks for. */
  evidence: (card: ProjectTaskMeta) => TagClearInput
  /** Drop the tag. `false` = the board refused; the card lands in `failed`. */
  untag: (slug: string) => Promise<boolean>
  log: (line: string) => void
}

/**
 * ONE DRAIN PASS over a board, for ONE tag.
 *
 * SEQUENTIAL, like `dispatchUnits`: these are sentinel round trips, and a backlog
 * of them fired at once is how one board RPC budget becomes N.
 *
 * QUIET ON A CARD THAT KEEPS ITS TAG, LOUD ON EVERY CLEAR. This runs on the
 * scanner tick, so a line per kept card would be the same handful of cards every
 * 45 seconds forever -- and the kept reasons are already visible where a human
 * looks for them, as the scan's own refusal buckets. A CLEAR is different: it is
 * a mutation of somebody's card, it happens once, and it is the line you grep for
 * when a card you tagged is suddenly untagged.
 */
export async function drainTag(tag: string, deps: DrainDeps): Promise<DrainReport> {
  const report: DrainReport = { cleared: [], kept: [], failed: [] }
  for (const card of deps.cards) {
    const verdict = decideTagClear(deps.evidence(card))
    if (!verdict.clear) {
      if (card.tags.includes(tag)) report.kept.push({ slug: card.slug, reason: verdict.reason })
      continue
    }
    if (await deps.untag(card.slug)) {
      report.cleared.push(card.slug)
      deps.log(`[drain] ${card.slug}: dropped \`${tag}\` -- the work landed`)
    } else {
      report.failed.push(card.slug)
      deps.log(`[drain] ${card.slug}: could NOT drop \`${tag}\` -- the board refused the write; still tagged`)
    }
  }
  return report
}
