/**
 * The live-store side of the dialog bridge: what is open, and what each
 * conversation is called.
 *
 * Split from `answer-dialog.ts` so the two consumers -- the tool that ANSWERS
 * and the hook that ANNOUNCES -- read the same two facts from one place, and
 * neither has to import the other.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { answerableDialogs, type PendingDialog } from './dialog-answerable'
import type { PromptableDialog } from './dialog-prompt'

/** The conversation's name, or a short id when it has none yet. */
export function conversationTitle(conversationId: string): string {
  const conv = useConversationsStore.getState().conversationsById[conversationId] as { title?: string } | undefined
  return conv?.title?.trim() || conversationId.slice(0, 8)
}

/** Every open question the orb may answer, named, asks first. */
export function openAnswerable(): PromptableDialog[] {
  const store = useConversationsStore.getState()
  const dialogs: PendingDialog[] = Object.entries(store.pendingDialogs).map(([conversationId, d]) => ({
    conversationId,
    dialogId: d.dialogId,
    layout: d.layout,
    expired: d.expired,
    source: d.source,
  }))
  return answerableDialogs(store.pendingAskQuestions, dialogs).map(d => ({
    ...d,
    conversationTitle: conversationTitle(d.conversationId),
  }))
}
