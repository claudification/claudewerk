/**
 * WHICH PROJECT THE BOARD IS LOOKING AT.
 *
 * The board is ambient: it shows the SELECTED conversation's project, exactly
 * like the card-hover provider. Reading it through a hook keeps the project out
 * of component signatures that have no other use for it.
 *
 * Returns a STRING (never an object literal) so the Zustand selector identity
 * stays stable -- a selector returning a fresh object every render is React #185
 * waiting to happen.
 *
 * Extracted from `epic-run-button.tsx` when the pin button needed the same
 * answer. Two copies of "which project is this" is how two board controls end up
 * writing to two different boards.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

export function useAmbientProject(): string | null {
  return useConversationsStore(s =>
    s.selectedConversationId ? (s.conversationsById[s.selectedConversationId]?.project ?? null) : null,
  )
}
