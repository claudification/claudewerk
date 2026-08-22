/**
 * THE NIGHT RUN'S BOARD DOOR -- the write only nightshift makes, plus the one
 * builder that wires the board into the scanner's deps.
 *
 * The two READS moved to `board-cards.ts` when `refine` and `work-order` got a
 * caller of their own and needed the identical list; they were module-private
 * here only because nightshift was once the only scanner anything invoked. The
 * dequeue below stayed: it WRITES, and no other scanner has business reaching it.
 *
 * This file exists so the scanner's deps can be built from a `callBoard`-shaped
 * function alone, which is what lets the orchestrator swap the board out in a
 * test the same way it already swaps the spawn and the sentinel (`NightshiftIo`).
 * Nothing here holds state.
 */

import { NIGHTSHIFT_TAG } from '../shared/nightshift-types'
import type { Conversation } from '../shared/protocol'
import { type CallBoard, listBoardCards, readBoardCard } from './board-cards'
import type { ConversationStore } from './conversation-store'
import type { NightshiftScanDeps } from './scanners/nightshift-scanner'
import { werkLiveness } from './werk-liveness'

/**
 * Drop `#nightshift` from a card. THIS IS THE DEQUEUE.
 *
 * Under the copy-queue, dispatching a task removed its file from
 * `.nightshift/queue/`; under the tag, dispatching it removes the tag. Same
 * meaning ("this is no longer waiting for a night run"), except it is written
 * on the card, where a human can see it, instead of in a store nobody opens.
 *
 * Re-reads the card first rather than patching a remembered tag list: minutes
 * can pass between the scan and the dispatch, and clobbering a tag somebody
 * added in between would be a silent edit to their card.
 */
export async function untagBoardCard(
  call: CallBoard,
  store: ConversationStore,
  project: string,
  slug: string,
): Promise<boolean> {
  const card = await readBoardCard(call, store, project, slug)
  if (!card) return false
  if (!card.tags.includes(NIGHTSHIFT_TAG)) return true
  const res = await call(store, project, {
    op: 'update',
    slug,
    patch: { tags: card.tags.filter(t => t !== NIGHTSHIFT_TAG) },
  })
  return !!res.ok
}

/** The registry reads the scan needs. Structural, so a test hands over a plain
 *  object rather than a whole ConversationStore. */
interface NightshiftScanStore {
  getAllConversations: () => Conversation[]
  getActiveConversationCount: (id: string) => number
}

/**
 * THE ONE BUILDER for the nightshift scan's deps -- board door, registry door,
 * clock, cap.
 *
 * Both paths into `nightshiftScanner` come through here: `scanBoardForTasks`
 * (the DISPATCH path, which opens a run) and `outlookForProject` (the READ path,
 * which renders the pane as a dry run). They wrote the same seven fields twice
 * before this existed, which is a drift waiting to happen in the direction that
 * matters most -- a preview that quietly disagrees with the run it previews.
 *
 * `admitted` is deliberately NOT built here. It is the one field the two paths
 * genuinely disagree about: dispatch pushes into the run's pending list, the
 * outlook into a throwaway it serializes and drops. Leaving it caller-owned is
 * what keeps this a wiring helper rather than a second selector.
 *
 * NOTHING HERE WRITES. `listCards`/`readCard` are the two read ops; `untagBoardCard`
 * -- the dequeue -- is not wired in, which is what lets the outlook path use the
 * identical deps as the run and still be a dry run by construction.
 */
export function buildNightshiftScanDeps(
  call: CallBoard,
  store: ConversationStore,
  project: string,
  totalTasks: number,
): Omit<NightshiftScanDeps, 'admitted'> {
  const s = store as unknown as NightshiftScanStore
  return {
    getAllConversations: s.getAllConversations,
    isLive: werkLiveness(s.getActiveConversationCount),
    log: line => console.log(line),
    now: () => Date.now(),
    project,
    listCards: () => listBoardCards(call, store, project),
    readCard: slug => readBoardCard(call, store, project, slug),
    totalTasks,
  }
}
