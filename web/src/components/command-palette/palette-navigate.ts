import { useConversationsStore } from '@/hooks/use-conversations'
import { recordSwitch } from '@/lib/conversation-frequency'
import type { Conversation, ProjectOrder } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'
import { isProjectInWorkspace } from '@/lib/workspace-membership'

/**
 * When you jump to a project/conversation from the command palette (or search)
 * that lives OUTSIDE the active workspace, the sidebar -- scoped to that
 * workspace -- would hide it, forcing the manual "switch to All, then navigate"
 * dance before you could see or click around the target. This reveals it by
 * dropping the workspace filter to the All view (null) in exactly that case.
 *
 * This is the ONE sanctioned spot where an explicit user navigation may clear
 * the active workspace, and it stays inside the covenant in
 * workspace-membership.ts: it is a FORWARD check only ("is this project in the
 * CURRENTLY active workspace?"). It never derives WHICH workspace owns the
 * target, so no reverse-lookup is introduced and the store's
 * selectConversation/selectProject remain workspace-neutral.
 */
function revealTargetProject(projectUri: string): void {
  const store = useConversationsStore.getState()
  const activeWs = store.controlPanelPrefs.activeWorkspaceId
  if (!activeWs) return // already on the All view -- nothing is hidden

  const order = store.projectOrder as ProjectOrder
  // A worktree conversation is filed in the sidebar under its PARENT project, so
  // count the parent as in-workspace too -- otherwise jumping to a worktree conv
  // of an in-workspace project would needlessly kick you out to All.
  const parentUri = parseWorktreeUri(projectUri)?.parentUri
  const inWorkspace =
    isProjectInWorkspace(order, activeWs, projectUri) ||
    (parentUri ? isProjectInWorkspace(order, activeWs, parentUri) : false)

  if (!inWorkspace) store.updateControlPanelPrefs({ activeWorkspaceId: null })
}

/** Pick a conversation from the palette: reveal it if out-of-workspace, record the switch, navigate. */
export function selectConversationFromPalette(conversation: Conversation, onSelect: (id: string) => void): void {
  revealTargetProject(conversation.project)
  recordSwitch(conversation.project)
  onSelect(conversation.id)
}

/** Pick a project from the palette: reveal it if out-of-workspace, then navigate. */
export function selectProjectFromPalette(projectUri: string): void {
  revealTargetProject(projectUri)
  useConversationsStore.getState().selectProject(projectUri)
}
