import { isAdHocConversation, worktreeBranchOf } from '@/lib/conversation-axes'
import type { Conversation } from '@/lib/types'
import { type EpicSeatGroup, groupEpicSeats } from './epic-seat-group'

/** Walks conversations once and splits them into mutually exclusive buckets.
 *
 *  EPIC SEATS COME OUT FIRST, before any other test. An overseer and its
 *  implementers/verifiers nest together whether or not they are ad-hoc and
 *  whether or not they sit in a worktree -- so the seat test has to win over
 *  both, which it cannot do from inside the bucket table below.
 *
 *  The rest fall through an ORDERED PREDICATE TABLE rather than an if-chain:
 *  each bucket is a named test, first match wins, no match is `normal`. The
 *  chain this replaced branched on three unrelated mechanisms inline (a URI
 *  parse, a magic capability string, and an implicit else), which is how the
 *  role dimension stayed invisible for so long -- there was nowhere to add it.
 *
 *  There is no `ended` bucket: the sidebar never renders an ended conversation,
 *  so a status view derived from the rendered rows would always be empty. The
 *  dismiss affordances read the project's ended set from the store instead
 *  (`useEndedIdsForProject`). */

type FallthroughBucket = 'worktrees' | 'adhoc'

/** First match wins. Order is meaningful: an ad-hoc conversation running in a
 *  worktree files under `worktrees`, which is how it has always behaved. */
const BUCKETS: Array<{ name: FallthroughBucket; matches: (c: Conversation) => boolean }> = [
  { name: 'worktrees', matches: c => worktreeBranchOf(c) !== null },
  { name: 'adhoc', matches: isAdHocConversation },
]

export interface ConversationPartition {
  /** Overseer-headed subtrees, newest group first. Rendered ABOVE everything
   *  else in the project -- an overseer heads its project group. */
  epicGroups: EpicSeatGroup[]
  worktrees: Conversation[]
  adhoc: Conversation[]
  normal: Conversation[]
}

export function partitionConversations(conversations: Conversation[]): ConversationPartition {
  const { groups: epicGroups, rest } = groupEpicSeats(conversations)

  const worktrees: Conversation[] = []
  const adhoc: Conversation[] = []
  const normal: Conversation[] = []
  const into: Record<FallthroughBucket, Conversation[]> = { worktrees, adhoc }

  for (const c of rest) {
    const bucket = BUCKETS.find(b => b.matches(c))
    if (bucket) into[bucket.name].push(c)
    else normal.push(c)
  }

  const byStartedAt = (a: Conversation, b: Conversation) => b.startedAt - a.startedAt
  return {
    epicGroups,
    worktrees: worktrees.sort(byStartedAt),
    adhoc: adhoc.sort(byStartedAt),
    normal: normal.sort(byStartedAt),
  }
}
