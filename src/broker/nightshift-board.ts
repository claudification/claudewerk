/**
 * THE NIGHT RUN'S BOARD DOOR -- the one builder that wires the board into the
 * scanner's deps.
 *
 * The two READS moved to `board-cards.ts` when `refine` and `work-order` got a
 * caller of their own and needed the identical list; they were module-private
 * here only because nightshift was once the only scanner anything invoked.
 *
 * THE DEQUEUE MOVED TOO, and later, to `tag-clear.ts` as `clearCardTag`. It lived
 * here as `untagBoardCard` because nightshift was the only scanner that cleared
 * anything, and it was hard-coded to `#nightshift` for the same reason. Once the
 * refine clock needed the identical write the choice was a second copy or a
 * neutral door, and the answer was the same one the reads got.
 *
 * This file exists so the scanner's deps can be built from a `callBoard`-shaped
 * function alone, which is what lets the orchestrator swap the board out in a
 * test the same way it already swaps the spawn and the sentinel (`NightshiftIo`).
 * Nothing here holds state and nothing here writes.
 */

import type { Conversation } from '../shared/protocol'
import { type CallBoard, listBoardCards, readBoardCard } from './board-cards'
import type { ConversationStore } from './conversation-store'
import type { NightshiftScanDeps } from './scanners/nightshift-scanner'
import { werkLiveness } from './werk-liveness'

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
 * NOTHING HERE WRITES. `listCards`/`readCard` are the two read ops; the drain
 * (`clearCardTag`) is not wired in, which is what lets the outlook path use the
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
