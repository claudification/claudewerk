/**
 * Which conversation a batch reads its cards from, and which one it is sent to.
 *
 * These are two different questions and the selector used to answer both with
 * "whatever is selected in the app". That is wrong the moment a dispatch site is
 * scoped to something else -- a project board shows ONE project, which is not
 * always the project of the selected conversation, and a board detached into its
 * own window makes that the normal case rather than the edge one. The symptom
 * was "work on this epic" opening an empty selector: project A's card ids ticked
 * against project B's card list.
 *
 * RELAY may fall back to any live conversation, because reading a project's
 * cards through the wrong host is harmless -- the board op carries the project
 * uri. TARGET must NOT: sending a batch prompt to an arbitrary conversation is
 * how the wrong agent gets handed someone else's work.
 */

export interface BatchConversation {
  id: string
  status: string
}

export interface BatchTargets {
  /** Conversation to read the project's cards through. Null = nothing live. */
  relay: string | null
  /** Conversation the prompt is submitted to. Null = submitting is not allowed. */
  target: string | null
}

const live = (list: BatchConversation[], id: string | null | undefined): string | null =>
  id ? (list.find(c => c.id === id && c.status !== 'ended')?.id ?? null) : null

export function resolveBatchTargets(
  conversations: BatchConversation[],
  /** Pinned by the dispatch site (a board hands us its own). */
  pinned: string | null | undefined,
  /** The app's current selection. */
  selected: string | null | undefined,
): BatchTargets {
  const target = live(conversations, pinned) ?? live(conversations, selected)
  return {
    relay: target ?? conversations.find(c => c.status !== 'ended')?.id ?? null,
    target,
  }
}
