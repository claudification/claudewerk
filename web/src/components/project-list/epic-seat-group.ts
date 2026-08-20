/**
 * SEATS NEST UNDER THE OVERSEER THAT DISPATCHED THEM.
 *
 * The visual is the one `lineage.ts` already ships -- head first, members
 * indented ONE level, groups ordered newest-first. This file only changes the
 * KEY, because spawn lineage is the wrong edge for an epic run twice over:
 *
 *   1. The seats have no lineage edge at all. `epic-sweep-loop.ts` dispatches
 *      every seat with `rendezvousCallerConversationId: null`, so each one is
 *      self-rooted. (Setting that field to the overseer was rejected: it also
 *      hangs `pendingSpawnApproval` on the caller, so an unattended overseer
 *      would collect an approval prompt per dispatch.)
 *   2. Even with the edge, lineage roots at a CONVERSATION and overseer
 *      generations ROTATE. Seats rooted at generation 32 would hang under a dead
 *      row the moment generation 33 took the lease.
 *
 * So the key is `overseerScopeKey()` -- the epic today, the project the day the
 * lease becomes a project singleton. Nothing here changes when that happens.
 *
 * TWO LIVE OVERSEERS IN ONE PROJECT IS POSSIBLE, and is not a case to guard
 * against: the lease is per epic card, so each epic holds its own. One subtree
 * per scope key falls out of that, which keeps the missing project singleton
 * VISIBLE rather than silently merging two runs into one misleading tree.
 */

import { CONVERSATION_ROLE_RANK, classifyConversationRole, overseerScopeKey } from '@shared/conversation-role'
import type { Conversation } from '@/lib/types'

export interface EpicSeatGroup {
  /** `overseerScopeKey` shared by every member. */
  key: string
  /** The head. ABSENT when no overseer for this scope is in the visible set --
   *  its generation ended, or it is in another project. Members then render
   *  FLAT rather than indented under nothing, matching how `lineage.ts` handles
   *  a vanished root. */
  overseer?: Conversation
  /** Implementers and verifiers, overseer excluded. */
  seats: Conversation[]
}

/**
 * Split conversations into overseer-headed subtrees plus everything else.
 *
 * MEMBERSHIP IGNORES THE OTHER TWO AXES ON PURPOSE. A seat joins its subtree
 * whether or not it is ad-hoc and whether or not it runs in a worktree -- that
 * is the whole "whether they are ad hoc or not" requirement, and it is why this
 * runs BEFORE the worktree/adhoc partition rather than inside it.
 */
export function groupEpicSeats(conversations: Conversation[]): {
  groups: EpicSeatGroup[]
  rest: Conversation[]
} {
  const byKey = new Map<string, Conversation[]>()
  const rest: Conversation[] = []

  for (const c of conversations) {
    const key = overseerScopeKey(c)
    if (!key || classifyConversationRole(c) === 'normal') {
      rest.push(c)
      continue
    }
    const members = byKey.get(key)
    if (members) members.push(c)
    else byKey.set(key, [c])
  }

  const groups = [...byKey.entries()]
    .map(([key, members]) => assembleGroup(key, members))
    .sort((a, b) => b.newest - a.newest)
    .map(r => r.group)

  return { groups, rest }
}

/** Assemble one subtree: pull out the head, order the seats, and compute the
 *  group's recency so groups sort newest-first like every other list here. */
function assembleGroup(key: string, members: Conversation[]): { group: EpicSeatGroup; newest: number } {
  const overseer = members.find(c => classifyConversationRole(c) === 'overseer')
  const seats = members
    .filter(c => c !== overseer)
    .sort(
      (a, b) =>
        CONVERSATION_ROLE_RANK[classifyConversationRole(a)] - CONVERSATION_ROLE_RANK[classifyConversationRole(b)] ||
        a.startedAt - b.startedAt,
    )
  const newest = Math.max(...members.map(c => c.startedAt))
  return { group: { key, ...(overseer && { overseer }), seats }, newest }
}
