/**
 * THE DIALOGUE (D2) — the host-apply fold for the live-dialog store, split out
 * of use-live-dialogs.ts so neither file outgrows the LOC cap. `applyHostUpdate`
 * is the one place a host snapshot becomes a store entry + view, shared by every
 * apply path (show / patch / reopen / orphan) so entry and view stay in lockstep.
 */

import type { DialogOp, DialogSnapshot } from '@shared/dialog-live'
import { clearPref, getPref } from './live-dialog-prefs'
import { type DialogViewState, foldPrefs, transitionView } from './live-dialog-view'

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

/** The two store maps applyHostUpdate reads + returns (a slice of the store). */
export interface DialogMaps {
  byConversation: Record<string, LiveDialogEntry>
  viewByConversation: Record<string, DialogViewState>
}

/** Fold a host apply into BOTH maps: bump the authoritative entry (rev++) and run
 *  the view transition (value reconcile + collapse/decay clock), then restore the
 *  per-viewer minimize/dismiss the user set before a reload. A pref for a different
 *  dialogId is stale (a new dialog replaced the slot) -> drop it. */
export function applyHostUpdate(
  maps: DialogMaps,
  conversationId: string,
  snapshot: DialogSnapshot,
  extra: Partial<Pick<LiveDialogEntry, 'lastOps' | 'rationale' | 'replay' | 'orphanedReason'>>,
  ops: DialogOp[],
): DialogMaps {
  const prev = maps.byConversation[conversationId]
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
  const derived = transitionView(
    maps.viewByConversation[conversationId],
    snapshot,
    prev?.snapshot.status,
    ops,
    Date.now(),
  )
  const pref = getPref(conversationId)
  if (pref && pref.dialogId !== snapshot.dialogId) clearPref(conversationId)
  const view = foldPrefs(derived, pref)
  return {
    byConversation: { ...maps.byConversation, [conversationId]: entry },
    viewByConversation: { ...maps.viewByConversation, [conversationId]: view },
  }
}
