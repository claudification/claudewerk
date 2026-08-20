/**
 * `navigateFromWall` -- THE WALL is a DRIVER, not a destination.
 *
 * A click on the wall usually lands SOMEWHERE ELSE: the main window opens the
 * epic, the card or the conversation and raises itself, and the wall does not
 * change, because you are still watching it. A hover never comes through here at
 * all.
 *
 * WHY THE PATHS. The wall's React tree runs in the window that OPENED the popup
 * -- `openDetachedWindow` only portals the DOM across -- so the normal detached
 * case is still a direct call. A popup that was RELOADED is a genuinely separate
 * context, and then the intent has to cross:
 *
 *   target 'wall'           -> the wall's OWN surface; never raise anything
 *   not a wall popup        -> apply here, raise this window
 *   popup, opener alive     -> postMessage to the opener, raise IT
 *   popup, opener CLOSED    -> say so; a dead click is the bug this prevents
 *   popup, opener ref gone  -> BroadcastChannel, the reload fallback
 *
 * THE `wall` TARGET IS NOT "APPLY HERE". It is answered by the wall's own detail
 * panel, which renders inside `.wall-root` -- and that matters precisely because
 * the ordinary detached wall PORTALS its DOM into the popup while its React tree
 * stays in the opener. An in-wall target that merely applied "here" would open a
 * MAIN-WINDOW modal and raise the dashboard over the popup you are looking at:
 * the dead-letter bug this transport exists to kill, running backwards.
 *
 * THE TARGET IS A PARAMETER, NOT A CONSTANT. `wall-commit-detail-in-wall`
 * (Jonas, 2026-08-20) opens a commit's detail INSIDE the wall window rather than
 * shipping you to the dashboard, and a transport that hardcoded "every row goes
 * to the main window" would have forced that card to fork a second mechanism.
 * So the destination is chosen per click; `main` is merely the default. The
 * target never travels in the envelope -- it is what decides whether the intent
 * crosses at all.
 *
 * THERE IS NO `attention` KIND, on purpose. An attention row's title points at a
 * CONVERSATION (the question lives inside one), so it takes the `conversation`
 * intent. A second kind that did the same thing would be two spellings of one
 * verb, and the row's buttons answer in place without coming through here.
 *
 * OWNERSHIP. `wall-navigation-and-hover` (W4) owns this symbol per the epic's
 * contract table. Do not fork it, and do not add a second transport beside it.
 * The receiving half is `wall-nav-receiver.ts`, mounted in the main window.
 */

import { openCommitDetail } from '@/hooks/use-commit-modals'
import { useConversationsStore } from '@/hooks/use-conversations'
import { openKanbanModal } from '@/hooks/use-kanban-modal'
import { showToast } from '@/lib/toast-bus'
import { openProjectCard } from '../conversation-detail/project-card-verbs'
import { openWallCommitDetail } from './wall-detail-store'
import { WALL_MODAL } from './wall-state'

/** What a wall row asks a window to open. One entry per clickable row. */
export type WallNavIntent =
  /** The EPICS view for this project, scrolled to (and reading) this epic. */
  | { kind: 'epic'; project: string; id: string }
  /** One board card, in its own editor. */
  | { kind: 'card'; project: string; id: string }
  /**
   * One conversation, selected and read. `via` is the selection SOURCE tag the
   * store already records for every other entry point (`sheaf`,
   * `command-palette`), so a wall-driven focus is distinguishable in telemetry
   * from a click in the sidebar.
   */
  | { kind: 'conversation'; id: string; via?: string }
  /** One commit's full detail -- message, files, diffstat, transcript link. */
  | { kind: 'commit'; hash: string }

/** WHERE the intent is meant to land. `main` ships it to the dashboard; `wall`
 *  keeps it in the window the click happened in. */
export type WallNavTarget = 'main' | 'wall'

/** How the intent got there -- returned so a caller (and a test) can tell the
 *  difference between "opened" and "shouted into a closed window". */
export type WallNavDelivery = 'here' | 'wall' | 'opener' | 'broadcast' | 'dead-opener'

/** The `postMessage` envelope, and the BroadcastChannel name. Shared so the
 *  receiving half does not have to guess either. */
export const WALL_NAV_MESSAGE = 'wall:navigate'

/** Default selection source for a conversation opened off the wall. */
const WALL_SELECT_SOURCE = 'wall'

/** Do the thing, in whatever window this is running in. Exported for the
 *  receiving half, which is the same apply on the other side of the wire. */
export function applyWallIntent(intent: WallNavIntent): void {
  if (intent.kind === 'epic') {
    useConversationsStore.getState().setPendingEpicReveal({ epicId: intent.id })
    openKanbanModal(intent.project)
    return
  }
  if (intent.kind === 'conversation') {
    useConversationsStore.getState().selectConversation(intent.id, intent.via ?? WALL_SELECT_SOURCE)
    return
  }
  if (intent.kind === 'commit') {
    openCommitDetail(intent.hash)
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

/**
 * Answer an intent on the WALL's own surface. `false` = there is no in-wall
 * surface for this kind, so the caller falls through to the main window rather
 * than swallowing the click.
 *
 * Only a commit has one, and that is the whole of Jonas's exception: an epic or
 * a card is a place you go and WORK, which is the main window's job.
 */
function applyInWall(intent: WallNavIntent): boolean {
  if (intent.kind !== 'commit') return false
  openWallCommitDetail(intent.hash)
  return true
}

export function navigateFromWall(intent: WallNavIntent, target: WallNavTarget = 'main'): WallNavDelivery {
  // Asked for the WALL: answer it on the wall's own surface, whatever window
  // this code happens to be running in, and raise NOTHING. Deliberately ahead of
  // the detached check -- the portaled case looks exactly like the inline one
  // from in here, and it is the case where raising the opener would bury the
  // popup the click came from.
  if (target === 'wall' && applyInWall(intent)) return 'wall'

  const detached = inDetachedWallContext()

  if (!detached) {
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
