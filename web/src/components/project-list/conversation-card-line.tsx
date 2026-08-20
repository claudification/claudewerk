/**
 * WHAT THIS CONVERSATION IS WORKING ON -- the board card, on the row.
 *
 * The association was already on the wire and nothing rendered it: an epic seat
 * carries `epic.cardId` and a board-spawned ad-hoc carries `adHocTaskId`. Both
 * reached the browser; neither reached a pixel. So "which card is this
 * implementer on" could only be answered by opening the conversation.
 *
 * Reuses `CardChip`, which already owns the glyph, the lane colour, the hover
 * panel, the click-through and the right-click menu. A second chip here would be
 * a second thing to keep in sync with the markdown renderer's twin.
 */

import { CardChip } from '@/components/cards/card-chip'
import { projectBoardCardRef } from '@/lib/cards'
import type { Conversation } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'

/**
 * The card this row is working on, or null.
 *
 * An OVERSEER deliberately has none -- `EpicLaunchTag.cardId` is optional
 * precisely because the overseer "serves the whole epic rather than any one
 * card". Showing it the epic card here would imply it is implementing that
 * card, which is the one thing an overseer never does.
 */
function cardIdOf(conversation: Conversation): string | null {
  return conversation.epic?.cardId ?? conversation.adHocTaskId ?? null
}

/**
 * The project whose BOARD owns the card.
 *
 * A seat usually runs inside a worktree, and the worktree URI is a different
 * project to every lookup in the panel -- but the board lives in the main
 * checkout, so a worktree-scoped lookup would miss every card. Collapse to the
 * parent, exactly as the sidebar's own grouping does.
 */
function boardScopeOf(conversation: Conversation): string {
  return parseWorktreeUri(conversation.project)?.parentUri ?? conversation.project
}

export function ConversationCardLine({ conversation }: { conversation: Conversation }) {
  const cardId = cardIdOf(conversation)
  if (!cardId) return null

  return (
    <div className="mt-0.5 pl-4 flex items-center gap-1 text-[9px] min-w-0">
      <span className="text-fg-faint shrink-0" aria-hidden="true">
        {'▸'}
      </span>
      <CardChip cardRef={projectBoardCardRef(cardId, boardScopeOf(conversation))} />
    </div>
  )
}
