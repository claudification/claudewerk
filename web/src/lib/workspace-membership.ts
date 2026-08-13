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

/** Every node id in a tree -- groups AND projects. Membership is asked about
 *  both: the sidebar can put a whole group into a workspace. */
function nodeIdsInTree(tree: ProjectOrderNode[], into = new Set<string>()): Set<string> {
  for (const node of tree) {
    into.add(node.id)
    if (node.type === 'group') nodeIdsInTree(node.children, into)
  }
  return into
}

/** True when a node (project OR group) sits anywhere in that workspace's tree. */
export function isNodeInWorkspace(order: ProjectOrder, wsId: string, nodeId: string): boolean {
  return nodeIdsInTree(order.workspaceTrees?.[wsId] ?? []).has(nodeId)
}

/** EVERY workspace holding this node -- zero, one, or many. There is no "the"
 *  workspace of a project; any caller reaching for a single id (the old
 *  `projectInWorkspace` helper returned the FIRST match and rendered membership
 *  as if it were exclusive) is asking the wrong question. */
export function workspaceIdsForNode(order: ProjectOrder, nodeId: string): Set<string> {
  const out = new Set<string>()
  for (const wsId of Object.keys(order.workspaceTrees ?? {})) {
    if (isNodeInWorkspace(order, wsId, nodeId)) out.add(wsId)
  }
  return out
}

/** Drop a node from a workspace tree at ANY depth. Removing a group takes its
 *  subtree with it; removing a project leaves its (possibly now empty) parent
 *  group standing -- that group is the user's structure, not a leftover. Pure:
 *  returns a new tree, touching only the branches that changed. */
export function removeNodeDeep(tree: ProjectOrderNode[], nodeId: string): ProjectOrderNode[] {
  const out: ProjectOrderNode[] = []
  for (const node of tree) {
    if (node.id === nodeId) continue
    if (node.type === 'group') out.push({ ...node, children: removeNodeDeep(node.children, nodeId) })
    else out.push(node)
  }
  return out
}

/** Find a node by id anywhere in a tree -- used to copy a GROUP (with its
 *  children) into a workspace instead of filing its id as a bogus project node,
 *  which is what the assign menu used to do. */
export function findNode(tree: ProjectOrderNode[], nodeId: string): ProjectOrderNode | undefined {
  for (const node of tree) {
    if (node.id === nodeId) return node
    if (node.type === 'group') {
      const hit = findNode(node.children, nodeId)
      if (hit) return hit
    }
  }
  return undefined
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
