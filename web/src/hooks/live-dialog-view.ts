/**
 * THE DIALOGUE (D2) — panel-owned view state for a live dialog, split out of the
 * store so neither file outgrows the LOC cap. This is the persisted interaction
 * layer (form values, the in-flight wait bar, the collapsed/decay view) plus the
 * pure transition that folds a host apply into it.
 */
import type { DialogOp, DialogSnapshot, DialogStatus } from '@shared/dialog-live'
import { getInitialValues, reconcileValues } from '@/components/dialog/dialog-form-init'
import type { DialogViewPref } from './live-dialog-prefs'

/** Panel-owned interaction state, persisted across the unmount that a
 *  conversation switch causes. The mounted component mirrors values/pending/
 *  submitRev/activeAction down here every render; collapsed/closedAt are owned
 *  here outright (the agent-close transition + the minimize control set them). */
export interface DialogViewState {
  dialogId: string
  values: Record<string, unknown>
  /** A submit was sent and we're waiting for the agent's patch (the wait bar). */
  pending: boolean
  /** entry.rev at submit time -- a later rev means the agent responded. */
  submitRev: number
  activeAction: string | null
  /** Minimized into the bar (manual) or auto-collapsed (agent closed it). */
  collapsed: boolean
  /** Armed by a SHIFT+send: this collapse auto-restores on the NEXT real agent
   *  update. Transient (never persisted) -- any manual minimize/expand disarms it. */
  restoreOnUpdate: boolean
  /** epoch ms the agent drove the dialog terminal -- drives the decay + hard hide. */
  closedAt?: number
}

/** Transient fields the mounted component owns and mirrors down via syncView. */
export type ViewMirror = Pick<DialogViewState, 'values' | 'pending' | 'submitRev' | 'activeAction'>

const isTerminal = (s: DialogStatus | undefined): boolean => s === 'closed' || s === 'orphaned'

/** A clean view for a brand-new (or replacing) dialog. */
export function freshView(snapshot: DialogSnapshot): DialogViewState {
  return {
    dialogId: snapshot.dialogId,
    values: getInitialValues(snapshot.layout),
    pending: false,
    submitRev: -1,
    activeAction: null,
    collapsed: false,
    restoreOnUpdate: false,
  }
}

/** Fold a host apply (patch/reopen/orphan) into the view: reconcile values,
 *  resolve the wait bar (an apply means the agent acted), and drive the
 *  collapse/decay clock off the open->terminal / terminal->open transition. */
export function transitionView(
  prev: DialogViewState | undefined,
  snapshot: DialogSnapshot,
  prevStatus: DialogStatus | undefined,
  ops: DialogOp[],
  now: number,
  replay = false,
): DialogViewState {
  const sameDialog = !!prev && prev.dialogId === snapshot.dialogId
  const base = sameDialog ? (prev as DialogViewState) : freshView(snapshot)
  const values = reconcileValues(base.values, snapshot.layout, ops)
  let { collapsed, closedAt, restoreOnUpdate } = base
  if (isTerminal(snapshot.status) && !isTerminal(prevStatus)) {
    // Agent drove it terminal -> auto-collapse into the decaying bar.
    collapsed = true
    closedAt = now
    restoreOnUpdate = false
  } else if (snapshot.status === 'open' && isTerminal(prevStatus)) {
    // Reopened -> bring it back into full view, cancel the decay clock.
    collapsed = false
    closedAt = undefined
    restoreOnUpdate = false
  } else if (restoreOnUpdate && collapsed && !replay) {
    // SHIFT+send minimized this and the agent just patched it (a real update,
    // not a reconnect replay) -> pop it back open and disarm.
    collapsed = false
    restoreOnUpdate = false
  }
  return { ...base, values, pending: false, collapsed, closedAt, restoreOnUpdate }
}

/** Fold a persisted per-viewer MINIMIZE pref into a freshly-derived view, so a
 *  reload restores the user's minimize. A pref only applies to the SAME dialogId
 *  (a new dialog supersedes a stale minimize); the caller clears the stale pref.
 *  An agent-close collapse is kept regardless. Pure -- prefs I/O lives in the
 *  store. (Dismiss is authoritative + broker-side, NOT folded here.) */
export function foldPrefs(view: DialogViewState, pref: DialogViewPref | undefined): DialogViewState {
  if (!pref || pref.dialogId !== view.dialogId) return view
  return { ...view, collapsed: view.collapsed || pref.collapsed }
}
