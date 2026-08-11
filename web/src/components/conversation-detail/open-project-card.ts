/**
 * Open ONE board card, on its own -- no Kanban board behind it.
 *
 * The card editor is already mounted next to the transcript (`TaskEditorOverlay`,
 * fed by `pendingTaskEdit`), so opening a card is a store write, not a second
 * surface. Every "show me this card" entry point comes through here: the command
 * palette, and a `.rclaude/project/**` card link in rendered markdown.
 *
 * The id is the whole address -- a card's lane never affects where it lives.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

export function openProjectCard(id: string): void {
  useConversationsStore.getState().setPendingTaskEdit({ slug: id })
}
