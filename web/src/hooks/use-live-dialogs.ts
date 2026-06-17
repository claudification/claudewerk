/**
 * THE DIALOGUE (D2) — live/persistent dialog store (control panel).
 *
 * One entry per conversation (the broker holds a single live slot). The HOST
 * owns the authoritative snapshot; this store mirrors it and the panel owns
 * transient input state (in the component, NOT here). WS handlers call the apply
 * mutations; the component reads the entry + emits dialog_event on submit.
 *
 * Kept separate from the giant use-conversations store so the live-dialog churn
 * (patches, highlights) never re-notifies fleet-list subscribers.
 */

import type { DialogOp, DialogSnapshot } from '@shared/dialog-live'
import { create } from 'zustand'
import { wsSend } from './use-conversations'

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

function upsert(
  state: LiveDialogsState,
  conversationId: string,
  next: Omit<LiveDialogEntry, 'rev' | 'conversationId' | 'dialogId'>,
): Partial<LiveDialogsState> {
  const prev = state.byConversation[conversationId]
  return {
    byConversation: {
      ...state.byConversation,
      [conversationId]: {
        ...next,
        conversationId,
        dialogId: next.snapshot.dialogId,
        rev: (prev?.rev ?? 0) + 1,
      },
    },
  }
}

export const useLiveDialogsStore = create<LiveDialogsState>((set, get) => ({
  byConversation: {},

  show: (conversationId, snapshot) =>
    set(state => upsert(state, conversationId, { snapshot, lastOps: [], replay: false })),

  applyPatch: (conversationId, snapshot, ops, rationale, replay) =>
    set(state => upsert(state, conversationId, { snapshot, lastOps: ops, rationale, replay })),

  applyReopen: (conversationId, snapshot) =>
    set(state => upsert(state, conversationId, { snapshot, lastOps: [], replay: false })),

  applyOrphaned: (conversationId, snapshot, reason) =>
    set(state => upsert(state, conversationId, { snapshot, lastOps: [], replay: false, orphanedReason: reason })),

  setError: (conversationId, error) =>
    set(state => {
      const prev = state.byConversation[conversationId]
      if (!prev) return state
      return { byConversation: { ...state.byConversation, [conversationId]: { ...prev, error, rev: prev.rev + 1 } } }
    }),

  clearError: conversationId =>
    set(state => {
      const prev = state.byConversation[conversationId]
      if (!prev?.error) return state
      const { error: _e, ...rest } = prev
      return { byConversation: { ...state.byConversation, [conversationId]: { ...rest, rev: prev.rev + 1 } } }
    }),

  emit: (conversationId, dialogId, handlerId, on, value, state) =>
    wsSend('dialog_event', { conversationId, dialogId, handlerId, on, value, state }),

  dismiss: conversationId =>
    set(state => {
      if (!state.byConversation[conversationId]) return state
      const { [conversationId]: _gone, ...rest } = state.byConversation
      return { byConversation: rest }
    }),
}))
