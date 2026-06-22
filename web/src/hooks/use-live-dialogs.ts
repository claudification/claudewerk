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
import { type DialogViewState, freshView, transitionView, type ViewMirror } from './live-dialog-view'
import { wsSend } from './use-conversations'

export { CLOSED_DECAY_MS } from './live-dialog-view'

export interface LiveDialogEntry {
  conversationId: string
  dialogId: string
  snapshot: DialogSnapshot
  /** Ops from the most recent patch -- the component applies setState/unsetState
   *  to its input values and highlights changed block ids. Empty on show/replay. */
  lastOps: DialogOp[]
  rationale?: string
  /** The last update was a reconnect replay (adopt snapshot; no highlight). */
  replay: boolean
  orphanedReason?: string
  /** Broker rejected the last dialog_event (rate_limited / denied / ...). */
  error?: string
  /** Monotonic local revision -- bumps on every apply so the component's
   *  reconcile/highlight effect re-runs even when seq is unchanged (replay). */
  rev: number
}

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

type Maps = Pick<LiveDialogsState, 'byConversation' | 'viewByConversation'>

/** Fold a host apply into BOTH maps: bump the authoritative entry (rev++) and run
 *  the view transition (value reconcile + collapse/decay clock). Shared by every
 *  apply path so the entry/view stay in lockstep. */
function applyHostUpdate(
  state: LiveDialogsState,
  conversationId: string,
  snapshot: DialogSnapshot,
  extra: Partial<Pick<LiveDialogEntry, 'lastOps' | 'rationale' | 'replay' | 'orphanedReason'>>,
  ops: DialogOp[],
): Maps {
  const prev = state.byConversation[conversationId]
  const entry: LiveDialogEntry = {
    snapshot,
    lastOps: extra.lastOps ?? [],
    replay: extra.replay ?? false,
    rationale: extra.rationale,
    orphanedReason: extra.orphanedReason,
    conversationId,
    dialogId: snapshot.dialogId,
    rev: (prev?.rev ?? 0) + 1,
  }
  const view = transitionView(
    state.viewByConversation[conversationId],
    snapshot,
    prev?.snapshot.status,
    ops,
    Date.now(),
  )
  return {
    byConversation: { ...state.byConversation, [conversationId]: entry },
    viewByConversation: { ...state.viewByConversation, [conversationId]: view },
  }
}

export const useLiveDialogsStore = create<LiveDialogsState>(set => ({
  byConversation: {},
  viewByConversation: {},

  show: (conversationId, snapshot) =>
    set(state => {
      const maps = applyHostUpdate(state, conversationId, snapshot, { lastOps: [], replay: false }, [])
      // A fresh show resets the view outright (new dialog supersedes any prior).
      return { ...maps, viewByConversation: { ...state.viewByConversation, [conversationId]: freshView(snapshot) } }
    }),

  applyPatch: (conversationId, snapshot, ops, rationale, replay) =>
    set(state => applyHostUpdate(state, conversationId, snapshot, { lastOps: ops, rationale, replay }, ops)),

  applyReopen: (conversationId, snapshot) =>
    set(state => applyHostUpdate(state, conversationId, snapshot, { lastOps: [], replay: false }, [])),

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
      return { viewByConversation: { ...state.viewByConversation, [conversationId]: { ...prev, collapsed } } }
    }),

  emit: (conversationId, dialogId, handlerId, on, value, state) =>
    wsSend('dialog_event', { conversationId, dialogId, handlerId, on, value, state }),

  dismiss: conversationId =>
    set(state => {
      if (!state.byConversation[conversationId] && !state.viewByConversation[conversationId]) return state
      const { [conversationId]: _gone, ...rest } = state.byConversation
      const { [conversationId]: _goneView, ...restView } = state.viewByConversation
      return { byConversation: rest, viewByConversation: restView }
    }),
}))
