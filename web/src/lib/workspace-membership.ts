// Workspace membership + "last conversation per workspace" bookkeeping. Kept
// standalone (no store import) so both the conversations store and
// project-list/workspace-hooks.ts can depend on it without a cycle.
import type { ProjectOrder, ProjectOrderNode } from '@/lib/types'

// Walks the whole tree, not just two levels: `ProjectOrderGroup.children` is
// typed `ProjectOrderNode[]`, so a group can nest, and a project buried in a
// nested group is still in the workspace.
function projectIdsInTree(tree: ProjectOrderNode[], into = new Set<string>()): Set<string> {
  for (const node of tree) {
    if (node.type === 'project') into.add(node.id)
    else projectIdsInTree(node.children, into)
  }
  return into
}

export function isProjectInWorkspace(order: ProjectOrder, wsId: string, projectUri: string): boolean {
  return projectIdsInTree(order.workspaceTrees?.[wsId] ?? []).has(projectUri)
}

/** Every project URI in a workspace, in tree order. A workspace the user has
 *  never populated returns []. Used by the launch resolver to auto-assume a
 *  workspace holding exactly one project. */
export function projectsInWorkspace(order: ProjectOrder, wsId: string): string[] {
  return [...projectIdsInTree(order.workspaceTrees?.[wsId] ?? [])]
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
