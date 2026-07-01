// Workspace membership + "last conversation per workspace" bookkeeping. Kept
// standalone (no store import) so both the conversations store and
// project-list/workspace-hooks.ts can depend on it without a cycle.
import type { ProjectOrder, ProjectOrderNode } from '@/lib/types'

export function projectIdsInTree(tree: ProjectOrderNode[]): Set<string> {
  const ids = new Set<string>()
  for (const node of tree) {
    if (node.type === 'project') ids.add(node.id)
    else for (const child of node.children) if (child.type === 'project') ids.add(child.id)
  }
  return ids
}

export function isProjectInWorkspace(order: ProjectOrder, wsId: string, projectUri: string): boolean {
  return projectIdsInTree(order.workspaceTrees?.[wsId] ?? []).has(projectUri)
}

const WS_LAST_CONV_KEY = 'workspace-last-conversation'

export function loadLastWorkspaceConversations(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(WS_LAST_CONV_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveLastWorkspaceConversation(wsId: string, convId: string | null): void {
  const map = loadLastWorkspaceConversations()
  if (convId) map[wsId] = convId
  else delete map[wsId]
  localStorage.setItem(WS_LAST_CONV_KEY, JSON.stringify(map))
}
