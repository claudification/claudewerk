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
import { collapseForUpdateView, setCollapsedView } from './live-dialog-collapse'
import { clearPref } from './live-dialog-prefs'
import { type DialogViewState, freshView, type ViewMirror } from './live-dialog-view'
import { wsSend } from './use-conversations'

export type { LiveDialogEntry } from './live-dialog-apply'

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
  /** Minimize / restore the dialog (per-viewer client pref, persisted to localStorage).
   *  A manual toggle DISARMS any pending SHIFT+send auto-restore. */
  setCollapsed: (conversationId: string, collapsed: boolean) => void
  /** SHIFT+send: minimize NOW and arm auto-restore on the next agent update.
   *  Transient (NOT persisted) -- it pops back the moment the agent replies. */
  collapseForUpdate: (conversationId: string) => void
  /** Emit one dialog_event (the batched "send to agent" submit, or a close). */
  emit: (
    conversationId: string,
    dialogId: string,
    handlerId: string,
    on: 'submit' | 'close' | 'click' | 'change',
    value: unknown,
    state: Record<string, unknown>,
  ) => boolean
  /** AUTHORITATIVE dismiss (the x): tell the broker to DROP the slot for everyone,
   *  then drop it locally. Not a client pref -- dismissed is dismissed. */
  dismiss: (conversationId: string) => void
  /** Broker confirmed an authoritative dismiss -> drop it from this panel's view. */
  applyDismissed: (conversationId: string, dialogId: string) => void
  /** Client-only hide (the agent-close decay timer) -- does NOT touch the broker. */
  hideLocal: (conversationId: string) => void
}

/** Drop a conversation's entry + view from both maps (local only). */
function dropMaps(
  maps: Pick<LiveDialogsState, 'byConversation' | 'viewByConversation'>,
  conversationId: string,
): Pick<LiveDialogsState, 'byConversation' | 'viewByConversation'> {
  const { [conversationId]: _gone, ...byConversation } = maps.byConversation
  const { [conversationId]: _goneView, ...viewByConversation } = maps.viewByConversation
  return { byConversation, viewByConversation }
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
      const next = setCollapsedView(conversationId, prev, collapsed)
      return { viewByConversation: { ...state.viewByConversation, [conversationId]: next } }
    }),

  collapseForUpdate: conversationId =>
    set(state => {
      const prev = state.viewByConversation[conversationId]
      if (!prev) return state
      const next = collapseForUpdateView(prev)
      return { viewByConversation: { ...state.viewByConversation, [conversationId]: next } }
    }),

  emit: (conversationId, dialogId, handlerId, on, value, state) =>
    wsSend('dialog_event', { conversationId, dialogId, handlerId, on, value, state }),

  dismiss: conversationId =>
    set(state => {
      const view = state.viewByConversation[conversationId]
      const entry = state.byConversation[conversationId]
      if (!entry && !view) return state
      // AUTHORITATIVE: tell the broker to drop the slot for everyone. Optimistically
      // drop locally + clear any minimize pref; the broker's broadcast confirms.
      const dialogId = view?.dialogId ?? entry?.dialogId
      if (dialogId) wsSend('dialog_live_dismiss', { conversationId, dialogId })
      clearPref(conversationId)
      return dropMaps(state, conversationId)
    }),

  applyDismissed: (conversationId, dialogId) =>
    set(state => {
      // Broker confirmed an authoritative dismiss. Guard on dialogId so a stale
      // broadcast can't drop a newer dialog that already replaced the slot.
      const current =
        state.byConversation[conversationId]?.dialogId ?? state.viewByConversation[conversationId]?.dialogId
      if (current && current !== dialogId) return state
      clearPref(conversationId)
      return dropMaps(state, conversationId)
    }),

  hideLocal: conversationId =>
    set(state => {
      if (!state.byConversation[conversationId] && !state.viewByConversation[conversationId]) return state
      return dropMaps(state, conversationId)
    }),
}))
