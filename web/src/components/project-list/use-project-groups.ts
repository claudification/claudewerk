import { useMemo } from 'react'
import { type ConversationStructure, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrderNode, ProjectSettings } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'

/**
 * Every derivation that turns the flat conversation structure into the shape the
 * sidebar renders: which project hosts which conversation, what the active
 * workspace filters down to, what is unorganized, what is inactive.
 *
 * Extracted out of `ProjectList` because eleven chained `useMemo`s in a component
 * that also owns collapse state and 400 lines of JSX is unreadable and untestable.
 * Pure derivation lives here; the component keeps rendering.
 */

export type ProjectOrder = { tree: ProjectOrderNode[]; workspaceTrees?: Record<string, ProjectOrderNode[]> }

export type ProjectGroups = {
  /** id -> structural shape, shared by every derivation below. */
  structureById: Map<string, ConversationStructure>
  /** The tree to render: the whole thing, or just the active workspace's slice. */
  filteredTree: ProjectOrderNode[]
  /** Host project URI -> conversation ids, after the showEnded filter. */
  visibleIdsByProject: Map<string, string[]>
  /** Project URI -> root ids of cross-project lineage members, sorted. */
  stubIdsByProject: Map<string, string[]>
  /** Pinned projects with nothing in them -- shown anyway. */
  pinnedNotInTree: string[]
  unorganized: Array<{ project: string; conversationIds: string[] }>
  inactive: ConversationStructure[][]
}

export function useProjectGroups(
  structure: ConversationStructure[],
  projectOrder: ProjectOrder,
  projectSettings: Record<string, ProjectSettings>,
  showEnded: boolean,
  activeWorkspaceId: string | null,
): ProjectGroups {
  const structureById = useMemo(() => {
    const map = new Map<string, ConversationStructure>()
    for (const s of structure) map.set(s.id, s)
    return map
  }, [structure])

  // Which projects are in the organized tree, by URI. Needed before
  // effectiveProjectByConvId, which uses it to decide worktree re-keying.
  const treeProjects = useMemo(() => {
    const projects = new Set<string>()
    function walk(nodes: ProjectOrderNode[]) {
      for (const n of nodes) {
        if (n.type === 'project') projects.add(n.id)
        else if (n.type === 'group') walk(n.children)
      }
    }
    walk(projectOrder.tree)
    return projects
  }, [projectOrder])

  // react-doctor-disable-next-line react-doctor/no-derived-state -- already using useMemo, not useState+useEffect
  const filteredTree = useMemo(() => {
    if (!activeWorkspaceId) return projectOrder.tree
    return projectOrder.workspaceTrees?.[activeWorkspaceId] ?? []
  }, [projectOrder, activeWorkspaceId])

  // Effective project URI per conversation: worktree URIs collapse to parent
  // (legacy support -- post-v7 these are canonical at the source, but the rewrite
  // is cheap and protects unmigrated rows). Exception: a worktree URI explicitly
  // placed in the organized tree stays where the user put it.
  const effectiveProjectByConvId = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of structure) {
      const wt = parseWorktreeUri(s.project)
      map.set(s.id, wt && !treeProjects.has(s.project) ? wt.parentUri : s.project)
    }
    return map
  }, [structure, treeProjects])

  const { idsByProject, crossProjectStubsByProject } = useMemo(
    () => groupByHostProject(structure, effectiveProjectByConvId),
    [structure, effectiveProjectByConvId],
  )

  const visibleIdsByProject = useMemo(() => {
    if (showEnded) return idsByProject
    const map = new Map<string, string[]>()
    for (const [project, ids] of idsByProject) {
      const filtered = ids.filter(id => structureById.get(id)?.status !== 'ended')
      if (filtered.length > 0) map.set(project, filtered)
    }
    return map
  }, [idsByProject, showEnded, structureById])

  // Stable-array form so ProjectNode's memo can shallow-compare instead of
  // rebuilding from a Set every render.
  const stubIdsByProject = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [project, rootIds] of crossProjectStubsByProject) map.set(project, Array.from(rootIds).sort())
    return map
  }, [crossProjectStubsByProject])

  const pinnedNotInTree = useMemo(() => {
    const result: string[] = []
    for (const [uri, ps] of Object.entries(projectSettings)) {
      if (ps.pinned && !treeProjects.has(uri) && !visibleIdsByProject.has(uri)) result.push(uri)
    }
    return result
  }, [projectSettings, treeProjects, visibleIdsByProject])

  const unorganized = useMemo(
    () => collectUnorganized(structure, treeProjects, visibleIdsByProject, effectiveProjectByConvId, structureById),
    [structure, treeProjects, visibleIdsByProject, effectiveProjectByConvId, structureById],
  )

  // Ended, not in the tree, no active sibling. lastActivity is read lazily from
  // the live store at sort time -- ended conversations rarely tick, and keeping it
  // out of the structural selector saves a re-render on every WS message.
  const inactive = useMemo(() => collectInactive(structure, treeProjects), [structure, treeProjects])

  return { structureById, filteredTree, visibleIdsByProject, stubIdsByProject, pinnedNotInTree, unorganized, inactive }
}

/**
 * File every conversation under the project that HOSTS its spawn lineage.
 *
 * Lineage transcends project boundaries: a conversation whose root lives in
 * another project is filed under the root's project so the chain stays visually
 * together, and its own project gets a dimmed stub pointing back at that root.
 * A conversation with no root, or whose root is not currently visible, is filed
 * under its own effective project.
 */
function pushInto(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function addInto(map: Map<string, Set<string>>, key: string, value: string) {
  const bag = map.get(key)
  if (bag) bag.add(value)
  else map.set(key, new Set([value]))
}

function groupByHostProject(structure: ConversationStructure[], effectiveProject: Map<string, string>) {
  const idsByProject = new Map<string, string[]>()
  const crossProjectStubsByProject = new Map<string, Set<string>>()

  for (const s of structure) {
    const ownProject = effectiveProject.get(s.id) ?? s.project
    const rootId = s.rootConversationId
    const rootProject = rootId ? effectiveProject.get(rootId) : undefined
    const elsewhere = rootId && rootProject && rootProject !== ownProject

    pushInto(idsByProject, rootProject ?? ownProject, s.id)
    if (elsewhere) addInto(crossProjectStubsByProject, ownProject, rootId)
  }

  return { idsByProject, crossProjectStubsByProject }
}

const isAdHoc = (structureById: Map<string, ConversationStructure>, id: string) =>
  !!structureById.get(id)?.capabilities?.includes('ad-hoc')

function collectUnorganized(
  structure: ConversationStructure[],
  treeProjects: Set<string>,
  visibleIdsByProject: Map<string, string[]>,
  effectiveProjectByConvId: Map<string, string>,
  structureById: Map<string, ConversationStructure>,
) {
  const seen = new Set<string>()
  const result: Array<{ project: string; conversationIds: string[] }> = []
  for (const s of structure) {
    const project = effectiveProjectByConvId.get(s.id) || s.project
    if (s.status === 'ended' || treeProjects.has(project) || seen.has(project)) continue
    seen.add(project)
    const ids = visibleIdsByProject.get(project) || []
    if (ids.length > 0) result.push({ project, conversationIds: ids })
  }
  // Ad-hoc-only groups sink to the bottom; within a tier, newest project first.
  result.sort((a, b) => {
    const aAdHoc = a.conversationIds.every(id => isAdHoc(structureById, id))
    const bAdHoc = b.conversationIds.every(id => isAdHoc(structureById, id))
    if (aAdHoc !== bAdHoc) return aAdHoc ? 1 : -1
    const newest = (ids: string[]) => Math.max(...ids.map(id => structureById.get(id)?.startedAt ?? 0))
    return newest(b.conversationIds) - newest(a.conversationIds)
  })
  return result
}

function collectInactive(structure: ConversationStructure[], treeProjects: Set<string>) {
  const activeProjects = new Set<string>()
  for (const s of structure) if (s.status !== 'ended') activeProjects.add(s.project)

  const byProject = new Map<string, ConversationStructure[]>()
  for (const s of structure) {
    if (s.status !== 'ended' || treeProjects.has(s.project) || activeProjects.has(s.project)) continue
    const group = byProject.get(s.project) || []
    group.push(s)
    byProject.set(s.project, group)
  }

  const { conversationsById } = useConversationsStore.getState()
  const newest = (group: ConversationStructure[]) =>
    Math.max(...group.map(s => conversationsById[s.id]?.lastActivity ?? 0))
  return Array.from(byProject.values()).sort((a, b) => newest(b) - newest(a))
}
