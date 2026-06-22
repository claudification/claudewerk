/**
 * THE DIALOGUE (D2) — the minimize/restore reducers for a live dialog, split out
 * of use-live-dialogs.ts so the store stays under the LOC cap. Two ways to
 * collapse: a MANUAL minimize (persisted, sticky) and a SHIFT+send minimize
 * (transient, auto-restores on the agent's next update -- see transitionView).
 */
import { setPref } from './live-dialog-prefs'
import type { DialogViewState } from './live-dialog-view'

/** Manual minimize/restore: persist the per-viewer pref so a reload restores it,
 *  and DISARM any pending SHIFT+send auto-restore (an explicit toggle wins). */
export function setCollapsedView(conversationId: string, view: DialogViewState, collapsed: boolean): DialogViewState {
  setPref(conversationId, { dialogId: view.dialogId, collapsed })
  return { ...view, collapsed, restoreOnUpdate: false }
}

/** SHIFT+send: minimize NOW and arm auto-restore on the next agent update.
 *  Transient -- NOT persisted, since it pops back the moment the agent replies. */
export function collapseForUpdateView(view: DialogViewState): DialogViewState {
  return { ...view, collapsed: true, restoreOnUpdate: true }
}
