/**
 * Bridge: which live dialogs (THE DIALOGUE) are MANUALLY minimized and should
 * surface in the global ModalDock.
 *
 * Additive integration — reads the live-dialog store, derives nothing back into
 * it. We surface only USER minimizes (`collapsed && !closedAt`); an agent-closed
 * dialog (closedAt set) keeps its own inline decay bar. We also drop the current
 * conversation: while you're viewing it, its inline CollapsedDialogBar already
 * covers the dialog, so the dock only shows parked dialogs from ELSEWHERE.
 *
 * Selects the raw store maps (stable refs) and computes with useMemo — never
 * returns a fresh array straight from a Zustand selector (React #185 trap).
 */
import { useMemo } from 'react'
import type { DialogViewState } from './live-dialog-view'
import { type LiveDialogEntry, useLiveDialogsStore } from './use-live-dialogs'

export interface MinimizedLiveDialog {
  conversationId: string
  /** The dialog's own title (layout.title), shown as the tile label. */
  title: string
}

/** Pure filter (unit-tested): manual minimizes (`collapsed && !closedAt`), with
 *  an entry, excluding the current conversation. */
export function selectMinimizedLiveDialogs(
  byConversation: Record<string, LiveDialogEntry>,
  viewByConversation: Record<string, DialogViewState>,
  currentConversationId: string | null,
): MinimizedLiveDialog[] {
  const out: MinimizedLiveDialog[] = []
  for (const [conversationId, view] of Object.entries(viewByConversation)) {
    if (!view.collapsed || view.closedAt !== undefined) continue
    if (conversationId === currentConversationId) continue
    const entry = byConversation[conversationId]
    if (!entry) continue
    out.push({ conversationId, title: entry.snapshot.layout.title })
  }
  return out
}

export function useMinimizedLiveDialogs(currentConversationId: string | null): MinimizedLiveDialog[] {
  const byConversation = useLiveDialogsStore(s => s.byConversation)
  const viewByConversation = useLiveDialogsStore(s => s.viewByConversation)
  return useMemo(
    () => selectMinimizedLiveDialogs(byConversation, viewByConversation, currentConversationId),
    [byConversation, viewByConversation, currentConversationId],
  )
}
