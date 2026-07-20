// The two ways the ACTIVE WORKSPACE is allowed to change, in one place:
// an explicit workspace switch (tab click / ctrl+N) and a quick-switch bounce
// (ctrl+Tab / FAB double-tap) restoring the workspace it recorded on the way in.
// Nothing else may touch `activeWorkspaceId` -- selection never drives the mode.
import { useConversationsStore } from '@/hooks/use-conversations'
import {
  loadValidWorkspaceConversation,
  saveLastWorkspaceConversation,
  WORKSPACE_ALL,
} from '@/lib/workspace-membership'

// Switching a workspace is the ONE and ONLY thing that changes the active
// workspace from user intent. Its entire side effect: remember the conversation
// we're leaving behind for the OLD workspace, flip the mode, then restore the NEW
// workspace's last conversation IF it still exists (a dead id is pruned and we
// drop to the workspace summary with nothing selected). It NEVER bounces you into
// a different workspace than the one you picked -- there is no reverse lookup.
export function switchWorkspace(id: string | null): void {
  const store = useConversationsStore.getState()
  const prevWs = store.controlPanelPrefs.activeWorkspaceId ?? WORKSPACE_ALL
  const curConv = store.selectedConversationId
  if (curConv) saveLastWorkspaceConversation(prevWs, curConv)

  const targetWs = id ?? WORKSPACE_ALL
  store.updateControlPanelPrefs({ activeWorkspaceId: id })

  const restored = loadValidWorkspaceConversation(
    targetWs,
    cid => !!useConversationsStore.getState().conversationsById[cid],
  )
  if (restored === curConv) return
  useConversationsStore.getState().selectConversation(restored ?? null, 'workspace-switch')
}

// A stamp is usable only while its workspace still exists; `_all` always does.
function isLiveWorkspace(wsId: string | undefined): wsId is string {
  if (!wsId) return false
  if (wsId === WORKSPACE_ALL) return true
  return (useConversationsStore.getState().projectOrder.workspaces ?? []).some(w => w.id === wsId)
}

// Ctrl+Tab / FAB double-tap: bounce to the previously visited conversation.
//
// The bounce restores the workspace recorded ON that visit, so it lands you
// exactly where you were. Without it, bouncing to a conversation living in
// another workspace fell through to the generic reveal, which drops you into the
// All view -- the workspace of the switch was lost and the round-trip was
// asymmetric. Reading a RECORDED VISIT is not the forbidden
// conversation->workspace reverse lookup (workspace-membership.ts): it answers
// "where was I standing", not "which workspace owns this".
export function quickSwitchConversation(): void {
  const store = useConversationsStore.getState()
  const visit = store.conversationMru.slice(1).find(e => e.id in store.conversationsById)
  if (!visit) return

  // A visit whose workspace is gone -> plain navigation, the store's reveal
  // decides the filter as it always did.
  if (!isLiveWorkspace(visit.workspaceId)) {
    store.selectConversation(visit.id, 'ctrl-tab')
    return
  }

  const curWs = store.controlPanelPrefs.activeWorkspaceId ?? WORKSPACE_ALL
  if (visit.workspaceId !== curWs) {
    const curConv = store.selectedConversationId
    if (curConv) saveLastWorkspaceConversation(curWs, curConv)
    store.updateControlPanelPrefs({
      activeWorkspaceId: visit.workspaceId === WORKSPACE_ALL ? null : visit.workspaceId,
    })
  }
  useConversationsStore.getState().selectConversation(visit.id, 'quick-switch')
}
