import type { Conversation } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'

/** Walks conversations once and returns four overlapping views:
 *  - worktrees / adhoc / normal: mutually exclusive, worktrees detected by URI,
 *    adhoc routed by capability, rest is normal
 *  - ended: status-based view, overlaps with all three (so DismissAllEndedButton
 *    sees the same conversations rendered in any list) */
export function partitionConversations(conversations: Conversation[]) {
  const worktrees: Conversation[] = []
  const adhoc: Conversation[] = []
  const normal: Conversation[] = []
  const ended: Conversation[] = []
  for (const s of conversations) {
    if (s.status === 'ended') ended.push(s)
    if (parseWorktreeUri(s.project)) worktrees.push(s)
    else if (s.capabilities?.includes('ad-hoc')) adhoc.push(s)
    else normal.push(s)
  }
  return { worktrees, adhoc, normal, ended }
}
