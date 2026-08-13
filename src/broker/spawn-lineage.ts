/**
 * Phase 2 spawn-parent-tracking: shared spawn-lineage resolver.
 *
 * The boot-lifecycle handler (PTY/headless boot path) and the claude-daemon
 * backend (daemon spawn path) both need to translate a `callerConversationId`
 * into a `{parent, root}` lineage at the moment a new conversation row is
 * first persisted. They differ only in WHERE they obtain the caller id from:
 *
 *   - boot-lifecycle: from the rendezvous registry (`getRendezvousInfo`),
 *     because the broker observes boot AFTER `addRendezvous`.
 *   - claude-daemon:  from `deps.rendezvousCallerConversationId` directly,
 *     because finalize-and-persist runs BEFORE the post-dispatch rendezvous
 *     registration in `dispatchSpawn`.
 *
 * The math afterward is identical: walk one ancestor up, default `root` to
 * `parent.rootConversationId ?? parent.id`. Best-effort -- a missing parent
 * row still records `parent = callerId`, `root = callerId` (Phase 4's UI
 * handles orphan-root rendering).
 *
 * Always logs a [parent-track] line (LOG EVERYTHING covenant). The `via`
 * tag lets the reader tell PTY-boot lineage from daemon lineage at a glance.
 */

import { DEFAULT_NOTIFY_PARENT_SETTLE_MS, type SpawnRequest } from '../shared/spawn-schema'
import type { ConversationStore, CreateConversationLineage } from './conversation-store'

/**
 * Resolve the effective notify-parent settle window (ms) for a spawn request.
 * `undefined` when the caller did not opt into the EXPENSIVE report-back. When
 * opted in, the caller-supplied `notifyParentSettleMs` wins, else the default.
 */
export function resolveNotifyParentSettleMs(
  req: Pick<SpawnRequest, 'notifyParent' | 'notifyParentSettleMs'>,
): number | undefined {
  if (!req.notifyParent) return undefined
  return req.notifyParentSettleMs ?? DEFAULT_NOTIFY_PARENT_SETTLE_MS
}

/** Optional lineage inputs. A bag, so this does not grow a 6th positional. */
export interface SpawnLineageOptions {
  /** EXPENSIVE report-back settle window (ms); see `resolveNotifyParentSettleMs`. */
  notifyParentSettleMs?: number
  /**
   * The conversation this spawn is a FORK OF. Takes precedence over `callerId`:
   * a fork's ancestor is what it forked from, not whoever happened to issue the
   * spawn. Without this, fork parentage was never recorded -- the web dialog has
   * no caller at all (a browser is not a conversation) so parent/root came out
   * NULL, and MCP `fork_from` recorded the calling agent, which looked correct
   * and pointed at the wrong conversation.
   */
  forkedFromId?: string
}

/**
 * Compute the lineage to persist for a freshly-created conversation.
 *
 * The ancestor is the fork source when this spawn is a fork, else the caller.
 * Returns `undefined` only when there is neither -- the conversation is then
 * self-rooted (default for human-started conversations).
 */
// fallow-ignore-next-line complexity
export function computeSpawnLineage(
  conversations: ConversationStore,
  callerId: string | null | undefined,
  conversationId: string,
  via: string,
  opts?: SpawnLineageOptions,
): CreateConversationLineage | undefined {
  const { notifyParentSettleMs, forkedFromId } = opts ?? {}
  const parentId = forkedFromId || callerId
  if (!parentId) {
    console.log(`[parent-track] conv=${conversationId.slice(0, 8)} parent=none root=self via=${via}`)
    return undefined
  }
  const parent = conversations.getConversation(parentId)
  const rootId = parent?.rootConversationId ?? parentId
  const missingTag = parent ? '' : ' (parent-missing)'
  const notifyTag = notifyParentSettleMs ? ` notifyParent=${notifyParentSettleMs}ms` : ''
  // Which edge was used is the whole point of the fix -- log it, or a future
  // reader cannot tell a fork's lineage from a spawn's from the log alone.
  const originTag = forkedFromId ? ` origin=fork caller=${callerId?.slice(0, 8) ?? 'none'}` : ' origin=spawn'
  console.log(
    `[parent-track] conv=${conversationId.slice(0, 8)} parent=${parentId.slice(0, 8)} root=${rootId.slice(0, 8)}${missingTag}${notifyTag}${originTag} via=${via}`,
  )
  return { parentConversationId: parentId, rootConversationId: rootId, notifyParentSettleMs }
}

/**
 * Collect a spawn-lineage subtree: the conversation `rootId` plus every
 * descendant reachable by walking `parentConversationId` edges downward.
 *
 * Pure, cycle-safe (each conversation is visited at most once), and returns
 * ids in breadth-first order with `rootId` first. `rootId` is always included
 * even when it is absent from `conversations` -- the caller decides what to do
 * with a root that no longer exists. Used by the "terminate full lineage"
 * dashboard action to enumerate everything a subtree-terminate would touch.
 */
// fallow-ignore-next-line complexity
export function collectLineageSubtree(
  conversations: Array<{ id: string; parentConversationId?: string | null }>,
  rootId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const c of conversations) {
    const parent = c.parentConversationId
    if (!parent) continue
    const siblings = childrenByParent.get(parent)
    if (siblings) siblings.push(c.id)
    else childrenByParent.set(parent, [c.id])
  }

  const order: string[] = []
  const seen = new Set<string>([rootId])
  const queue: string[] = [rootId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    order.push(id)
    for (const child of childrenByParent.get(id) ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }
  return order
}
