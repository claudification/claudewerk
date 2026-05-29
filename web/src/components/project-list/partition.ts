import type { Conversation } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'

/** Walks conversations once and returns four overlapping views:
 *  - worktrees / adhoc / normal: mutually exclusive, worktrees detected by URI,
 *    adhoc routed by capability, rest is normal
 *  - ended: status-based view, overlaps with all three (so DismissAllEndedButton
 *    sees the same conversations rendered in any list)
 *
 * Each bucket is sorted by startedAt descending (newest first) for stable display. */
export function partitionConversations(conversations: Conversation[]) {
  const worktrees: Conversation[] = []
  const adhoc: Conversation[] = []
  const normal: Conversation[] = []
  const ended: Conversation[] = []
  for (const s of conversations) {
    if (s.status === 'ended') ended.push(s)
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
    ended,
  }
}
