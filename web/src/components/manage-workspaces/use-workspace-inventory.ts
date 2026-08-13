/**
 * Everything the Manage Workspaces surface needs to render, derived from live
 * store state -- no draft, no Save button. Membership edits apply immediately
 * (they are one-click reversible and the sidebar reflects them instantly);
 * a draft layer here would only add a way for the two to disagree.
 *
 * The central structure is `memberOf`: projectUri -> Set<workspaceId>. It is a
 * MANY-to-many map on purpose. Nothing in this module may collapse it to
 * "the workspace of X".
 */

import { projectIdentityKey } from '@shared/project-uri'
import { useMemo } from 'react'
import { useConversationStructure, useConversationsStore } from '@/hooks/use-conversations'
import { extractProjectLabel, type ProjectOrder, type ProjectOrderNode, type Workspace } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'

export interface WorkspaceInventory {
  workspaces: Workspace[]
  /** Every project the user could file, sorted by display label. */
  projects: string[]
  /** projectUri -> the workspaces holding it (zero, one, or many). */
  memberOf: Map<string, Set<string>>
  /** Top-level nodes of one workspace's tree, in their stored order. */
  membersOf: (wsId: string) => ProjectOrderNode[]
  labelOf: (uri: string) => string
  /** Live (non-ended) conversation count for a project. */
  countOf: (uri: string) => number
}

function collectProjectIds(tree: ProjectOrderNode[], into: Set<string>): void {
  for (const node of tree) {
    if (node.type === 'project') into.add(node.id)
    else collectProjectIds(node.children, into)
  }
}

/** Worktree URIs collapse into their parent project unless explicitly placed. */
function effectiveProject(uri: string, placed: Set<string>): string {
  const wt = parseWorktreeUri(uri)
  return wt && !placed.has(uri) ? wt.parentUri : uri
}

function addMembership(map: Map<string, Set<string>>, projectUri: string, wsId: string): void {
  const bag = map.get(projectUri)
  if (bag) bag.add(wsId)
  else map.set(projectUri, new Set([wsId]))
}

function buildMemberOf(order: ProjectOrder): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const [wsId, tree] of Object.entries(order.workspaceTrees ?? {})) {
    const ids = new Set<string>()
    collectProjectIds(tree, ids)
    for (const id of ids) addMembership(map, id, wsId)
  }
  return map
}

export function useWorkspaceInventory(): WorkspaceInventory {
  const order = useConversationsStore(s => s.projectOrder) as ProjectOrder
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const structure = useConversationStructure()

  const placed = useMemo(() => {
    const ids = new Set<string>()
    collectProjectIds(order.tree ?? [], ids)
    for (const tree of Object.values(order.workspaceTrees ?? {})) collectProjectIds(tree, ids)
    return ids
  }, [order])

  const memberOf = useMemo(() => buildMemberOf(order), [order])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of structure) {
      if (s.status === 'ended') continue
      const eff = effectiveProject(s.project, placed)
      map.set(eff, (map.get(eff) ?? 0) + 1)
    }
    return map
  }, [structure, placed])

  const labelOf = useMemo(() => {
    return (uri: string) => projectSettings[projectIdentityKey(uri)]?.label || extractProjectLabel(uri)
  }, [projectSettings])

  const projects = useMemo(() => {
    const set = new Set<string>(placed)
    for (const s of structure) set.add(effectiveProject(s.project, placed))
    for (const uri of Object.keys(projectSettings)) set.add(uri)
    return [...set].sort((a, b) => labelOf(a).localeCompare(labelOf(b)))
  }, [placed, structure, projectSettings, labelOf])

  return {
    workspaces: order.workspaces ?? [],
    projects,
    memberOf,
    membersOf: (wsId: string) => order.workspaceTrees?.[wsId] ?? [],
    labelOf,
    countOf: (uri: string) => counts.get(uri) ?? 0,
  }
}
