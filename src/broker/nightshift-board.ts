/**
 * THE NIGHT RUN'S BOARD DOOR -- the three reads/writes the nightshift scanner
 * needs, and nothing else.
 *
 * `board-rpc.ts` already owns the broker -> sentinel -> `.rclaude/project/cards/`
 * hop and hands back a value rather than writing to a socket. This file is the
 * thin nightshift-shaped adapter over it: list, read one, drop the routing tag.
 *
 * It exists as its own module so the scanner's deps can be built from a
 * `callBoard`-shaped function alone, which is what lets the orchestrator swap
 * the board out in a test the same way it already swaps the spawn and the
 * sentinel (`NightshiftIo`). Nothing here holds state.
 */

import { NIGHTSHIFT_TAG } from '../shared/nightshift-types'
import type { ProjectTask, ProjectTaskMeta } from '../shared/project-task-types'
import type { callBoard } from './board-rpc'
import type { ConversationStore } from './conversation-store'

/** The one effect these helpers need. Shaped as the real `callBoard` so the
 *  orchestrator's IO seam can hold either it or a double. */
export type CallBoard = typeof callBoard

/** Every card on the project's board, any lane. `[]` when the sentinel is gone
 *  -- a night run with no board is an empty run, never a crash. */
export async function listBoardCards(
  call: CallBoard,
  store: ConversationStore,
  project: string,
): Promise<ProjectTaskMeta[]> {
  const res = await call(store, project, { op: 'list' })
  if (!res.ok) return []
  return (res.tasks as ProjectTaskMeta[] | undefined) ?? []
}

/** One card WITH its body -- the read that makes the task a reference rather
 *  than a copy. `null` when the card is gone or the sentinel refused. */
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
