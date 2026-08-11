/**
 * Open ONE board card, on its own -- no Kanban board behind it.
 *
 * The card editor is already mounted next to the transcript (`TaskEditorOverlay`,
 * fed by `pendingTaskEdit`), so opening a card is a store write, not a second
 * surface. Every "show me this card" entry point comes through here: the command
 * palette, and a `.rclaude/project/<lane>/<slug>.md` link in rendered markdown.
 *
 * The lane is a HINT -- see `useCardResolver`, which prefers the manifest's.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import type { TaskStatus } from '@/hooks/use-project'

export function openProjectCard(slug: string, laneHint?: TaskStatus): void {
  useConversationsStore.getState().setPendingTaskEdit({ slug, status: laneHint ?? '' })
}
