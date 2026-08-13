import type { Conversation } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'

/** Walks conversations once and splits them into three mutually exclusive
 *  buckets: worktrees detected by URI, adhoc routed by capability, rest is
 *  normal. Each bucket is sorted by startedAt descending (newest first).
 *
 *  There is no `ended` bucket: the sidebar never renders an ended conversation,
 *  so a status view derived from the rendered rows would always be empty. The
 *  dismiss affordances read the project's ended set from the store instead
 *  (`useEndedIdsForProject`). */
export function partitionConversations(conversations: Conversation[]) {
  const worktrees: Conversation[] = []
  const adhoc: Conversation[] = []
  const normal: Conversation[] = []
  for (const s of conversations) {
    if (parseWorktreeUri(s.project)) worktrees.push(s)
    // rule misclassifies string .includes / .indexOf as Array lookups (already documented in phase 6)
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    else if (s.capabilities?.includes('ad-hoc')) adhoc.push(s)
    else normal.push(s)
  }
  const byStartedAt = (a: Conversation, b: Conversation) => b.startedAt - a.startedAt
  return {
    worktrees: worktrees.sort(byStartedAt),
    adhoc: adhoc.sort(byStartedAt),
    normal: normal.sort(byStartedAt),
  }
}
