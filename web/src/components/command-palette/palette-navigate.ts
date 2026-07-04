import { recordSwitch } from '@/lib/conversation-frequency'
import type { Conversation } from '@/lib/types'

/**
 * Pick a conversation from the palette (keyboard or mouse): record the switch for
 * frequency ranking, then navigate. Shared by key-handlers.ts and
 * command-palette.tsx so the pair is defined once.
 *
 * Workspace reveal -- dropping the sidebar filter to All when the target lives
 * outside the active workspace -- is NOT here: it lives in the store's
 * selectConversation/selectProject (see revealWorkspaceForProject in
 * use-conversations.ts) so EVERY navigation surface gets it, not just the palette.
 */
export function selectConversationFromPalette(conversation: Conversation, onSelect: (id: string) => void): void {
  recordSwitch(conversation.project)
  onSelect(conversation.id)
}
