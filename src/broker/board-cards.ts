/**
 * THE BOARD, AS THE SCANNERS ASK FOR IT -- list every card, read one card.
 *
 * `board-rpc.ts` owns the broker -> sentinel -> `.rclaude/project/cards/` hop and
 * hands back a value rather than writing to a socket. This is the thin
 * scanner-shaped adapter over it: the two READ ops, typed, with the failure
 * answer each scanner already expects.
 *
 * IT USED TO LIVE IN `nightshift-board.ts`, module-private, because nightshift
 * was the only scanner with a caller. `scanner-clock.ts` gave `refine` and
 * `work-order` one, and both need the same list -- so the choice was a second
 * copy of `call(store, project, {op:'list'})` or a neutral door. The WRITE made
 * the same trip one card later and for the same reason: it is `clearCardTag` in
 * `tag-clear.ts` now, because refine's clock drains a tag too.
 *
 * NOTHING HERE HOLDS STATE, and nothing here writes. That is what lets the
 * nightshift outlook use the identical deps as the run it previews and still be a
 * dry run by construction.
 */

import type { ProjectTask, ProjectTaskMeta } from '../shared/project-task-types'
import type { callBoard } from './board-rpc'
import type { ConversationStore } from './conversation-store'

/** The one effect these helpers need. Shaped as the real `callBoard` so a
 *  caller's IO seam can hold either it or a double. */
export type CallBoard = typeof callBoard

/**
 * Every card on the project's board, any lane. Filtering is the scanner's job.
 *
 * `[]` WHEN THE SENTINEL IS GONE, never a throw: a sweep against a board nobody
 * can read is an empty sweep. Every scanner that consumes this treats an empty
 * board as "nothing selected" and says so through its own `idleReason`, which is
 * the honest render -- a throw here would surface as `runScan`'s `crashed`, and a
 * disconnected sentinel is not a crashed scanner.
 */
export async function listBoardCards(
  call: CallBoard,
  store: ConversationStore,
  project: string,
): Promise<ProjectTaskMeta[]> {
  const res = await call(store, project, { op: 'list' })
  if (!res.ok) return []
  return (res.tasks as ProjectTaskMeta[] | undefined) ?? []
}

/** One card WITH its body -- the read that makes a task a reference rather than
 *  a copy. `null` when the card is gone or the sentinel refused. */
export async function readBoardCard(
  call: CallBoard,
  store: ConversationStore,
  project: string,
  slug: string,
): Promise<ProjectTask | null> {
  const res = await call(store, project, { op: 'get', slug })
  if (!res.ok) return null
  return (res.task as ProjectTask | null) ?? null
}
