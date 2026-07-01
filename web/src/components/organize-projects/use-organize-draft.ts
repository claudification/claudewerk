import { projectIdentityKey } from '@shared/project-uri'
import { useCallback, useMemo, useState } from 'react'
import { saveProjectOrder, useConversationStructure, useConversationsStore } from '@/hooks/use-conversations'
import { extractProjectLabel, flattenProjectOrderTree, type ProjectOrderNode } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'
import { applyProjectDragEnd } from '../project-list/use-project-drag-drop'

function clone(tree: ProjectOrderNode[]): ProjectOrderNode[] {
  return tree.map(n => (n.type === 'group' ? { ...n, children: [...n.children] } : { ...n }))
}

function projectIdsOf(node: ProjectOrderNode): string[] {
  if (node.type === 'project') return [node.id]
  return node.children.flatMap(c => (c.type === 'project' ? [c.id] : []))
}

function treeProjectIds(tree: ProjectOrderNode[]): Set<string> {
  return new Set(tree.flatMap(projectIdsOf))
}

/** Worktree URIs collapse to their parent unless explicitly placed in the tree. */
function effectiveProject(uri: string, inTree: Set<string>): string {
  const wt = parseWorktreeUri(uri)
  return wt && !inTree.has(uri) ? wt.parentUri : uri
}

export interface OrganizeDraft {
  tree: ProjectOrderNode[]
  /** Projects not in any group, sorted by display label. */
  pool: string[]
  labelOf: (uri: string) => string
  countOf: (uri: string) => number
  addGroup: () => void
  renameGroup: (groupId: string, name: string) => void
  deleteGroup: (groupId: string) => void
  ungroup: (projectId: string) => void
  applyDrag: (activeId: string, overId: string | null) => void
  save: () => void
  dirty: boolean
}

/**
 * Local, cancellable draft of the project-order tree for the Organize modal.
 * Nothing persists until `save()`. The host should remount this hook (via a
 * `key` on the modal) each time it opens so the draft re-seeds from live state.
 */
export function useOrganizeDraft(): OrganizeDraft {
  const liveOrder = useConversationsStore(s => s.projectOrder)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const structure = useConversationStructure()

  const [tree, setTree] = useState<ProjectOrderNode[]>(() => clone(liveOrder?.tree ?? []))
  const [dirty, setDirty] = useState(false)

  const inTree = useMemo(() => treeProjectIds(tree), [tree])

  // Active-conversation count per effective project (worktrees collapse to parent).
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of structure) {
      if (s.status === 'ended') continue
      const eff = effectiveProject(s.project, inTree)
      map.set(eff, (map.get(eff) ?? 0) + 1)
    }
    return map
  }, [structure, inTree])

  // Every project the user could organize: live conversations (effective uri),
  // configured projects (settings), and anything already in the tree.
  const known = useMemo(() => {
    const set = new Set<string>(inTree)
    for (const s of structure) set.add(effectiveProject(s.project, inTree))
    for (const uri of Object.keys(projectSettings)) set.add(uri)
    return set
  }, [structure, projectSettings, inTree])

  const labelOf = useCallback(
    (uri: string) => projectSettings[projectIdentityKey(uri)]?.label || extractProjectLabel(uri),
    [projectSettings],
  )

  const pool = useMemo(
    () => [...known].filter(uri => !inTree.has(uri)).sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
    [known, inTree, labelOf],
  )

  const countOf = useCallback((uri: string) => counts.get(uri) ?? 0, [counts])

  const mutate = useCallback((next: ProjectOrderNode[] | null) => {
    if (!next) return
    setTree(next)
    setDirty(true)
  }, [])

  const addGroup = useCallback(() => {
    const id = `group-new-${Date.now()}`
    setTree(prev => [...prev, { id, type: 'group', name: 'New group', children: [] }])
    setDirty(true)
  }, [])

  const renameGroup = useCallback((groupId: string, name: string) => {
    setTree(prev => prev.map(n => (n.type === 'group' && n.id === groupId ? { ...n, name } : n)))
    setDirty(true)
  }, [])

  const deleteGroup = useCallback((groupId: string) => {
    // Dropping the group node returns its children to the unorganized pool.
    setTree(prev => prev.filter(n => n.id !== groupId))
    setDirty(true)
  }, [])

  const ungroup = useCallback(
    (projectId: string) => mutate(applyProjectDragEnd(tree, projectId, '__ungrouped__')),
    [tree, mutate],
  )

  const applyDrag = useCallback(
    (activeId: string, overId: string | null) => mutate(applyProjectDragEnd(tree, activeId, overId)),
    [tree, mutate],
  )

  const save = useCallback(() => {
    const order = { tree: flattenProjectOrderTree(tree) }
    useConversationsStore.getState().setProjectOrder(order)
    saveProjectOrder(order)
  }, [tree])

  return { tree, pool, labelOf, countOf, addGroup, renameGroup, deleteGroup, ungroup, applyDrag, save, dirty }
}
