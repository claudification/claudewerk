/**
 * The three things you can do TO a board card from outside the board.
 *
 * All three are store writes, not surfaces. The editor, the run dialog and the
 * epic-run dialog are already mounted next to the transcript (`DetailOverlays`),
 * so every "show me this card" / "start this card" entry point -- the command
 * palette, a `.rclaude/project/**` link in rendered markdown, a `CardChip`, the
 * card context menu -- parks an id here and the overlay claims it.
 *
 * The id is the whole address -- a card's lane never affects where it lives.
 *
 * OPEN, LAUNCH and RUN are three verbs on purpose. OPEN reads. LAUNCH spawns ONE
 * conversation a human drives. RUN arms the engine over a whole epic: one
 * werk-worker per ready card, a werk-verifier behind each, a werk-master between beats.
 * Collapsing LAUNCH and RUN into "start" would hide that difference behind a
 * label you read in half a second -- see `epic-run-button.tsx`.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

export function openProjectCard(id: string): void {
  useConversationsStore.getState().setPendingTaskEdit({ slug: id })
}

/** LAUNCH: one conversation for this one card. */
export function launchProjectCard(id: string): void {
  useConversationsStore.getState().setPendingCardLaunch({ slug: id })
}

/** RUN: hand this epic to the engine. Only ever offered on an epic. */
export function runProjectEpic(epicId: string): void {
  useConversationsStore.getState().setPendingEpicRun({ epicId })
}
