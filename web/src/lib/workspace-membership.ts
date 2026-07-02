// Workspace membership + "last conversation per workspace" bookkeeping. Kept
// standalone (no store import) so both the conversations store and
// project-list/workspace-hooks.ts can depend on it without a cycle.
import type { ProjectOrder, ProjectOrderNode } from '@/lib/types'

function projectIdsInTree(tree: ProjectOrderNode[]): Set<string> {
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

// Sentinel workspace id for the "All" view.
//
// A workspace is a MODE the user explicitly selects; it is NEVER derived from
// what is selected. The one and only thing a workspace remembers is its own
// last-selected conversation (keyed by workspace id, below), so switching back
// into it restores context. There is deliberately NO reverse "which workspace
// does this conversation/project belong to" map -- a project can belong to zero
// or many workspaces, so that lookup is unanswerable and its existence signals
// the wrong architecture (selection driving mode instead of mode filtering
// selection). It was deleted on purpose. Do not resurrect it.
export const WORKSPACE_ALL = '_all'

const WS_LAST_CONV_KEY = 'workspace-last-conversation'

function loadLastWorkspaceConversations(): Record<string, string> {
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

// The last conversation this workspace was left on, or undefined if none was
// recorded or the recorded one is no longer valid. `isValid` lets the caller
// reject dead/unknown conversation ids; a rejected entry is pruned in place so
// stale ids cannot accumulate across the lifetime of the map.
export function loadValidWorkspaceConversation(wsId: string, isValid: (convId: string) => boolean): string | undefined {
  const map = loadLastWorkspaceConversations()
  const convId = map[wsId]
  if (!convId) return undefined
  if (isValid(convId)) return convId
  delete map[wsId]
  localStorage.setItem(WS_LAST_CONV_KEY, JSON.stringify(map))
  return undefined
}
