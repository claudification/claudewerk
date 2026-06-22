/**
 * THE DIALOGUE (D2) — live/persistent dialog store (control panel).
 *
 * One entry per conversation (the broker holds a single live slot). The HOST
 * owns the authoritative snapshot; this store mirrors it. The panel owns
 * transient input state -- but, crucially, that state lives in
 * `viewByConversation` (see live-dialog-view.ts), NOT in the component, so
 * switching conversations and coming back does NOT wipe the user's half-filled
 * form or the "sent, waiting for the agent" bar. The mounted component is
 * authoritative while alive and mirrors its transient state down via `syncView`;
 * on remount it rehydrates from the store. Collapsed/closed view state is
 * store-authoritative (set by the agent-close transition + the minimize button),
 * since it changes even while the dialog is unmounted on another conversation.
 *
 * Kept separate from the giant use-conversations store so the live-dialog churn
 * (patches, highlights) never re-notifies fleet-list subscribers.
 */

import type { DialogOp, DialogSnapshot } from '@shared/dialog-live'
import { create } from 'zustand'
import { applyHostUpdate, type LiveDialogEntry } from './live-dialog-apply'
import { clearPref, setPref } from './live-dialog-prefs'
import { type DialogViewState, freshView, type ViewMirror } from './live-dialog-view'
import { wsSend } from './use-conversations'

export type { LiveDialogEntry } from './live-dialog-apply'
export { CLOSED_DECAY_MS } from './live-dialog-view'

interface LiveDialogsState {
  byConversation: Record<string, LiveDialogEntry>
  viewByConversation: Record<string, DialogViewState>
  show: (conversationId: string, snapshot: DialogSnapshot) => void
  applyPatch: (
    conversationId: string,
    snapshot: DialogSnapshot,
    ops: DialogOp[],
    rationale: string | undefined,
    replay: boolean,
  ) => void
  applyReopen: (conversationId: string, snapshot: DialogSnapshot) => void
  applyOrphaned: (conversationId: string, snapshot: DialogSnapshot, reason: string) => void
  setError: (conversationId: string, error: string) => void
  clearError: (conversationId: string) => void
  /** Mirror the mounted component's transient input state into the store so it
   *  survives the unmount on a conversation switch. Preserves collapsed/closedAt. */
  syncView: (conversationId: string, patch: Partial<ViewMirror>) => void
  /** Mark a submit in flight (the wait bar) -- store-side so it persists. */
  markSubmitted: (conversationId: string, submitRev: number) => void
  /** Minimize / restore the dialog (the user-driven collapse). */
  setCollapsed: (conversationId: string, collapsed: boolean) => void
  /** Emit one dialog_event (the batched "send to agent" submit, or a close). */
  emit: (
    conversationId: string,
    dialogId: string,
    handlerId: string,
    on: 'submit' | 'close' | 'click' | 'change',
    value: unknown,
    state: Record<string, unknown>,
  ) => boolean
  dismiss: (conversationId: string) => void
}

export const useLiveDialogsStore = create<LiveDialogsState>(set => ({
  byConversation: {},
  viewByConversation: {},

  show: (conversationId, snapshot) =>
    set(state => {
      // A fresh show resets the view outright (new dialog supersedes any prior
      // minimize/dismiss the user had on the slot).
      clearPref(conversationId)
      const maps = applyHostUpdate(state, conversationId, snapshot, { lastOps: [], replay: false }, [])
      return { ...maps, viewByConversation: { ...state.viewByConversation, [conversationId]: freshView(snapshot) } }
    }),

  applyPatch: (conversationId, snapshot, ops, rationale, replay) =>
    set(state => applyHostUpdate(state, conversationId, snapshot, { lastOps: ops, rationale, replay }, ops)),

  applyReopen: (conversationId, snapshot) =>
    set(state => {
      // An explicit agent reopen overrides a user dismiss/minimize -- bring it back.
      clearPref(conversationId)
      return applyHostUpdate(state, conversationId, snapshot, { lastOps: [], replay: false }, [])
    }),

  applyOrphaned: (conversationId, snapshot, reason) =>
    set(state => applyHostUpdate(state, conversationId, snapshot, { orphanedReason: reason }, [])),

  setError: (conversationId, error) =>
    set(state => {
      const prev = state.byConversation[conversationId]
      if (!prev) return state
      const view = state.viewByConversation[conversationId]
      return {
        byConversation: { ...state.byConversation, [conversationId]: { ...prev, error, rev: prev.rev + 1 } },
        // A rejected send is no longer in flight -- drop the wait bar.
        viewByConversation: view
          ? { ...state.viewByConversation, [conversationId]: { ...view, pending: false } }
          : state.viewByConversation,
      }
    }),

  clearError: conversationId =>
    set(state => {
      const prev = state.byConversation[conversationId]
      if (!prev?.error) return state
      const { error: _e, ...rest } = prev
      return { byConversation: { ...state.byConversation, [conversationId]: { ...rest, rev: prev.rev + 1 } } }
    }),

  syncView: (conversationId, patch) =>
    set(state => {
      const prev = state.viewByConversation[conversationId]
      if (!prev) return state
      return { viewByConversation: { ...state.viewByConversation, [conversationId]: { ...prev, ...patch } } }
    }),

  markSubmitted: (conversationId, submitRev) =>
    set(state => {
      const prev = state.viewByConversation[conversationId]
      if (!prev) return state
      return {
        viewByConversation: { ...state.viewByConversation, [conversationId]: { ...prev, pending: true, submitRev } },
      }
    }),

  setCollapsed: (conversationId, collapsed) =>
    set(state => {
      const prev = state.viewByConversation[conversationId]
      if (!prev) return state
      // Persist the minimize so a reload restores it (per-viewer, client-side).
      setPref(conversationId, { dialogId: prev.dialogId, collapsed, dismissed: false, closedAt: prev.closedAt })
      return { viewByConversation: { ...state.viewByConversation, [conversationId]: { ...prev, collapsed } } }
    }),

  emit: (conversationId, dialogId, handlerId, on, value, state) =>
    wsSend('dialog_event', { conversationId, dialogId, handlerId, on, value, state }),

  dismiss: conversationId =>
    set(state => {
      const view = state.viewByConversation[conversationId]
      const entry = state.byConversation[conversationId]
      if (!entry && !view) return state
      // Persist the dismiss (keyed to this dialogId) so a reload's replay snapshot
      // doesn't resurrect it. An agent reopen / a new dialog clears it.
      const dialogId = view?.dialogId ?? entry?.dialogId
      if (dialogId) setPref(conversationId, { dialogId, collapsed: false, dismissed: true, closedAt: view?.closedAt })
      const { [conversationId]: _gone, ...rest } = state.byConversation
      const { [conversationId]: _goneView, ...restView } = state.viewByConversation
      return { byConversation: rest, viewByConversation: restView }
    }),
}))
