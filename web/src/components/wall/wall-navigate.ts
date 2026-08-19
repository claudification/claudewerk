/**
 * `navigateFromWall` -- THE WALL is a DRIVER, not a destination.
 *
 * A click on the wall always lands SOMEWHERE ELSE: the main window opens the
 * epic or the card and raises itself, and the wall does not change, because you
 * are still watching it. A hover never comes through here at all.
 *
 * WHY THE THREE PATHS. The wall's React tree runs in the window that OPENED the
 * popup -- `openDetachedWindow` only portals the DOM across -- so the normal
 * detached case is still a direct call. A popup that was RELOADED is a genuinely
 * separate context, and then the intent has to cross:
 *
 *   not a wall popup        -> apply here, raise this window
 *   popup, opener alive     -> postMessage to the opener, raise IT
 *   popup, opener CLOSED    -> say so; a dead click is the bug this prevents
 *   popup, opener ref gone  -> BroadcastChannel, the reload fallback
 *
 * OWNERSHIP. `wall-navigation-and-hover` (W4) owns this symbol per the epic's
 * contract table. It sits behind `wall-filter-crosspane-proof`, which cannot
 * land until every pane exists -- so the panes would each have grown their own
 * click transport before W4 ever ran. This is the MINIMUM seam A8 needed, in one
 * file, for W4 to EXTEND: add the pulse / commit / ledger / attention intents to
 * `WallNavIntent`, and mount the receiving half in the main window. Do not fork
 * it, and do not add a second transport beside it.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { openKanbanModal } from '@/hooks/use-kanban-modal'
import { showToast } from '@/lib/toast-bus'
import { openProjectCard } from '../conversation-detail/project-card-verbs'
import { WALL_MODAL } from './wall-state'

/** What a wall row asks the main window to open. One entry per clickable row. */
export type WallNavIntent =
  /** The EPICS view for this project, scrolled to (and reading) this epic. */
  | { kind: 'epic'; project: string; id: string }
  /** One board card, in its own editor. */
  | { kind: 'card'; project: string; id: string }

/** How the intent got there -- returned so a caller (and a test) can tell the
 *  difference between "opened" and "shouted into a closed window". */
export type WallNavDelivery = 'here' | 'opener' | 'broadcast' | 'dead-opener'

/** The `postMessage` envelope, and the BroadcastChannel name. Shared so the
 *  receiving half W4 mounts does not have to guess either. */
export const WALL_NAV_MESSAGE = 'wall:navigate'

/** Do the thing, in whatever window this is running in. */
function applyWallIntent(intent: WallNavIntent): void {
  if (intent.kind === 'epic') {
    useConversationsStore.getState().setPendingEpicReveal({ epicId: intent.id })
    openKanbanModal(intent.project)
    return
  }
  // The board claims `pendingTaskEdit` when it mounts, so the modal opens first
  // -- otherwise a cross-project card would land in whichever board happened to
  // be open.
  openKanbanModal(intent.project)
  openProjectCard(intent.id)
}

/** True when this JS context IS the detached wall popup (it was reloaded there,
 *  so it is no longer the opener's own context). `openDetachedWindow` names the
 *  popup after the modal, which is what makes this answerable at all. */
function inDetachedWallContext(): boolean {
  return typeof window !== 'undefined' && window.name === WALL_MODAL.id
}

export function navigateFromWall(intent: WallNavIntent): WallNavDelivery {
  if (!inDetachedWallContext()) {
    applyWallIntent(intent)
    // Raise the window the intent just landed in. Harmless when it is already
    // focused, and the whole point when the wall is detached over it.
    try {
      window.focus()
    } catch {}
    return 'here'
  }

  const opener = window.opener as Window | null
  if (opener) {
    if (opener.closed) {
      showToast({
        title: 'The main window is closed',
        body: 'Reopen the dashboard and click again -- the wall has nowhere to send this.',
      })
      return 'dead-opener'
    }
    opener.postMessage({ type: WALL_NAV_MESSAGE, intent }, window.location.origin)
    try {
      opener.focus()
    } catch {}
    return 'opener'
  }

  // The popup survived a reload, so the opener REFERENCE is gone even though the
  // main window may be perfectly alive. Same-origin broadcast is the only way
  // back.
  new BroadcastChannel(WALL_NAV_MESSAGE).postMessage({ type: WALL_NAV_MESSAGE, intent })
  return 'broadcast'
}
