/**
 * THE THREE AXES, each asked exactly once.
 *
 *   role      WHAT IT IS     -> conversation-role-ui.tsx
 *   ad-hoc    HOW IT ENDS    -> here
 *   worktree  WHERE IT RUNS  -> here
 *
 * They are independent. An epic werk-worker is an `werk-worker`, IS ad-hoc, and
 * IS in a worktree, all at once -- which is why they were never collapsed into
 * one enum.
 *
 * `isAdHocConversation` exists because the raw
 * `conversation.capabilities?.includes('ad-hoc')` lookup was copy-pasted across
 * seven files. Seven copies of a magic string is seven places to miss when the
 * capability is renamed, and a `.includes` on a possibly-undefined array is a
 * silent `false` when the field simply has not arrived yet.
 */

import type { Conversation } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'

/** Ad-hoc = SELF-TERMINATING and task-bound: it runs one prompt, may merge its
 *  worktree, and ends itself. Says nothing about what seat it holds. */
export function isAdHocConversation(conversation: Pick<Conversation, 'capabilities'>): boolean {
  // rule misclassifies string .includes / .indexOf as Array lookups
  // react-doctor-disable-next-line react-doctor/js-set-map-lookups
  return conversation.capabilities?.includes('ad-hoc') ?? false
}

/** The worktree branch this conversation runs on, or null when it runs in the
 *  project root. Derived from the URI -- the sentinel owns URI<->path. */
export function worktreeBranchOf(conversation: Pick<Conversation, 'project'>): string | null {
  return parseWorktreeUri(conversation.project)?.branchName ?? null
}
