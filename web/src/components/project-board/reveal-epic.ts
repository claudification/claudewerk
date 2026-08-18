/**
 * Show me this EPIC -- from anywhere, board or no board.
 *
 * An epic is READ on the EPICS view (an index that ranks, a pane that reads),
 * never as a kanban card. So "go to my epic" cannot be "open the epic's card":
 * that is the same editor you were already in, minus the children table, the
 * rollup and the RUN button. It is a NAVIGATION, and the destination is a
 * surface, not a card.
 *
 * The intent is PARKED in the store rather than passed as a callback because
 * half the callers have no board mounted -- the card editor beside the
 * transcript is one modal on its own. So: open the Kanban surface for the
 * project, leave the epic id on the counter, and let `ProjectBoard` claim it
 * when it arrives. Same shape as `openProjectCard`, for the same reason.
 *
 * Never silent: a card whose project cannot be resolved says so, because a
 * dead click is indistinguishable from a broken one.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { openKanbanModal } from '@/hooks/use-kanban-modal'
import { showToast } from '@/lib/toast-bus'

export function revealEpic(conversationId: string, epicId: string): void {
  const store = useConversationsStore.getState()
  const projectUri = store.conversationsById[conversationId]?.project
  if (!projectUri) {
    showToast({ title: 'Could not open the epic', body: 'This conversation has no project board to show it on.' })
    return
  }
  store.setPendingEpicReveal({ epicId })
  openKanbanModal(projectUri)
}
