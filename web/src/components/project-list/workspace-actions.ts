// Every mutation of the workspace axis (the list itself, its per-workspace
// trees, colours and custom keys). Split out of workspace-hooks.ts, which now
// only owns the keyboard layer + the stale-pointer guard.
//
// MEMBERSHIP IS MANY-TO-MANY. A project belongs to zero, one, or many
// workspaces; nothing here may assume a single home. `toggleProject` is the
// primitive -- add/remove one (project, workspace) edge -- and every UI affordance
// is built from it.

import { useCallback } from 'react'
import { saveProjectOrder, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, ProjectOrderNode } from '@/lib/types'
import { findNode, isNodeInWorkspace, removeNodeDeep, saveLastWorkspaceConversation } from '@/lib/workspace-membership'
import { switchWorkspace } from '@/lib/workspace-switch'
import { WORKSPACE_COLORS } from './workspace-colors'

function mutateOrder(fn: (order: ProjectOrder) => ProjectOrder) {
  const cur = useConversationsStore.getState().projectOrder as ProjectOrder
  const next = fn(cur)
  useConversationsStore.getState().setProjectOrder(next)
  saveProjectOrder(next)
}

// Always an object, never undefined: the broker reads an OMITTED workspaceTrees
// as "leave it alone", and JSON drops undefined on the wire -- so emptying the
// last workspace tree has to travel as an explicit `{}` or it won't stick.
function setTrees(o: ProjectOrder, trees: Record<string, ProjectOrderNode[]>): ProjectOrder {
  return { ...o, workspaceTrees: trees }
}

/** Rewrite one workspace's tree; an emptied tree drops its key entirely. */
function withTree(o: ProjectOrder, wsId: string, next: ProjectOrderNode[]): ProjectOrder {
  const trees = { ...(o.workspaceTrees ?? {}) }
  if (next.length === 0) delete trees[wsId]
  else trees[wsId] = next
  return setTrees(o, trees)
}

function patchWorkspace(o: ProjectOrder, wsId: string, patch: Partial<{ name: string; color: string; key?: string }>) {
  return { ...o, workspaces: (o.workspaces ?? []).map(w => (w.id === wsId ? { ...w, ...patch } : w)) }
}

function newWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}`
}

/** The node to file under a workspace. A GROUP is copied whole (children and
 *  all) out of the global tree -- filing just its id as `{type:'project'}`, the
 *  old behaviour, produced a node the sidebar rendered as a broken project. */
function nodeForWorkspace(o: ProjectOrder, nodeId: string): ProjectOrderNode {
  const found = findNode(o.tree, nodeId)
  return found?.type === 'group' ? structuredClone(found) : { id: nodeId, type: 'project' }
}

export function useWorkspaceActions() {
  const setActive = useCallback(switchWorkspace, [])

  return {
    setActive,
    create(name: string, existingCount: number) {
      const id = newWorkspaceId()
      const color = WORKSPACE_COLORS[existingCount % WORKSPACE_COLORS.length]
      mutateOrder(o => ({ ...o, workspaces: [...(o.workspaces ?? []), { id, name, color }] }))
      setActive(id)
    },
    rename(wsId: string, name: string) {
      mutateOrder(o => patchWorkspace(o, wsId, { name }))
    },
    remove(wsId: string, activeId: string | null) {
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        delete trees[wsId]
        return { ...setTrees(o, trees), workspaces: (o.workspaces ?? []).filter(w => w.id !== wsId) }
      })
      // Drop the gone workspace's remembered conversation so it cannot linger.
      saveLastWorkspaceConversation(wsId, null)
      if (activeId === wsId) setActive(null)
    },
    recolor(wsId: string, color: string) {
      mutateOrder(o => patchWorkspace(o, wsId, { color }))
    },
    /** Set (or, with null, clear) the custom key binding for a workspace. */
    setKey(wsId: string, key: string | null) {
      mutateOrder(o => patchWorkspace(o, wsId, { key: key ?? undefined }))
    },
    /** Reorder the workspace list itself -- this also renumbers the positional
     *  Ctrl+N slots, which is why a custom key always wins over them. */
    reorder(orderedIds: string[]) {
      mutateOrder(o => {
        const byId = new Map((o.workspaces ?? []).map(w => [w.id, w]))
        const moved = orderedIds.flatMap(id => {
          const w = byId.get(id)
          return w ? [w] : []
        })
        // Anything the caller forgot to name keeps its relative position at the end.
        const rest = (o.workspaces ?? []).filter(w => !orderedIds.includes(w.id))
        return { ...o, workspaces: [...moved, ...rest] }
      })
    },
    assignProject(nodeId: string, wsId: string) {
      mutateOrder(o =>
        isNodeInWorkspace(o, wsId, nodeId)
          ? o
          : withTree(o, wsId, [...(o.workspaceTrees?.[wsId] ?? []), nodeForWorkspace(o, nodeId)]),
      )
    },
    /** Remove a member at ANY depth -- a project sitting inside a group in the
     *  workspace tree used to be unremovable from the menus. */
    removeFromWorkspace(nodeId: string, wsId: string) {
      mutateOrder(o => {
        const tree = o.workspaceTrees?.[wsId]
        if (!tree) return o
        return withTree(o, wsId, removeNodeDeep(tree, nodeId))
      })
    },
    /** The many-to-many primitive: flip ONE (node, workspace) edge. */
    toggleProject(nodeId: string, wsId: string) {
      mutateOrder(o => {
        const tree = o.workspaceTrees?.[wsId] ?? []
        if (isNodeInWorkspace(o, wsId, nodeId)) return withTree(o, wsId, removeNodeDeep(tree, nodeId))
        return withTree(o, wsId, [...tree, nodeForWorkspace(o, nodeId)])
      })
    },
    /** Reorder the top-level nodes of one workspace tree. */
    reorderInWorkspace(wsId: string, orderedIds: string[]) {
      mutateOrder(o => {
        const tree = o.workspaceTrees?.[wsId]
        if (!tree) return o
        const byId = new Map(tree.map(n => [n.id, n]))
        const moved = orderedIds.flatMap(id => {
          const node = byId.get(id)
          return node ? [node] : []
        })
        return withTree(o, wsId, [...moved, ...tree.filter(n => !orderedIds.includes(n.id))])
      })
    },
    removeFromAllWorkspaces(projectUri: string) {
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        for (const [wid, wTree] of Object.entries(trees)) {
          const next = removeNodeDeep(wTree, projectUri)
          if (next.length === 0) delete trees[wid]
          else trees[wid] = next
        }
        return setTrees(o, trees)
      })
    },
    createAndAssign(name: string, existingCount: number, projectUri: string) {
      const wsId = newWorkspaceId()
      const color = WORKSPACE_COLORS[existingCount % WORKSPACE_COLORS.length]
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        trees[wsId] = [{ id: projectUri, type: 'project' }]
        return { ...o, workspaces: [...(o.workspaces ?? []), { id: wsId, name, color }], workspaceTrees: trees }
      })
      setActive(wsId)
    },
  }
}
