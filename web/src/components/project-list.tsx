import { projectIdentityKey } from '@shared/project-uri'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type ConversationStructure,
  saveProjectOrder,
  useConversationStructure,
  useConversationsStore,
  wsSend,
} from '@/hooks/use-conversations'
import type { ProjectOrder, ProjectOrderNode } from '@/lib/types'
import { parseWorktreeUri } from '@/lib/utils'
import { MaybeProfiler } from './perf-profiler'
import { ConversationCompactPeek, InactiveProjectItem } from './project-list/conversation-item'
import { GroupNode } from './project-list/conversation-sorting'
import { PinnedProjectNode, ProjectNode } from './project-list/project-node'
import { WorkspaceTabs } from './project-list/workspace-tabs'

// Find the on-screen instance of a conversation row. Two ProjectLists are
// mounted at once: the desktop sidebar (hidden lg:flex -> display:none on
// mobile) AND the mobile sheet (Radix-portaled to body end). A bare
// document.querySelector hits the FIRST in DOM order -- the hidden desktop
// copy -- and scrollIntoView()/pulse on a display:none node is a no-op, which
// is why the mobile slider always stuck to the top. offsetParent is null for
// display:none elements, so this returns whichever copy is actually visible.
function findVisibleConversationEl(id: string): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>(`[data-conversation-id="${id}"]`)
  for (const el of els) if (el.offsetParent !== null) return el
  return els[0] ?? null
}

// ─── Main ProjectList ──────────────────────────────────────────────

export function ProjectList() {
  // Subscribes only to the structural shape (id+project+status+capabilities+
  // startedAt). Per-conversation field churn (tokenUsage, recap, stats, gitBranch,
  // streaming text, lastActivity) does NOT re-render ProjectList -- leaf
  // items subscribe to their own conversation by id and render in isolation.
  // lastActivity is intentionally excluded: it changes on every WS message
  // and is only used here for sorting ended conversations, where the value is
  // snapshotted lazily at sort time (see `inactive` memo below).
  const structure = useConversationStructure()
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const rawProjectOrder = useConversationsStore(s => s.projectOrder)
  const projectOrder = useMemo(() => (rawProjectOrder?.tree ? rawProjectOrder : { tree: [] }), [rawProjectOrder])
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const showEnded = useConversationsStore(s => s.controlPanelPrefs.showEndedConversations)
  const showInactive = useConversationsStore(s => s.controlPanelPrefs.showInactiveByDefault)
  const activeWorkspaceId = useConversationsStore(s => s.controlPanelPrefs.activeWorkspaceId)
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('collapsed-groups')
      return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
      return new Set()
    }
  })

  // Refresh timestamps periodically
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Ask the broker to replay the cached daemon roster on mount + every reconnect
  // so ghost rows (unattached daemon workers) light up immediately instead of
  // waiting up to one 10s sentinel poll. Subscribes to connectSeq only (changes
  // on reconnect), NOT the roster data -- the per-row useGhostShort reads that.
  const connectSeq = useConversationsStore(s => s.connectSeq)
  useEffect(() => {
    wsSend('daemon_roster_request')
  }, [connectSeq])

  // Single id -> structure index shared by the grouping memos below.
  const structureById = useMemo(() => {
    const map = new Map<string, ConversationStructure>()
    for (const s of structure) map.set(s.id, s)
    return map
  }, [structure])

  // Track which projects are in the organized tree (by project URI).
  // Defined before idsByProject because idsByProject uses it for worktree re-keying.
  const treeProjects = useMemo(() => {
    const projects = new Set<string>()
    function walk(nodes: ProjectOrderNode[]) {
      for (const n of nodes) {
        if (n.type === 'project') {
          projects.add(n.id)
        } else if (n.type === 'group') {
          walk(n.children)
        }
      }
    }
    walk(projectOrder.tree)
    return projects
  }, [projectOrder])

  // react-doctor-disable-next-line react-doctor/no-derived-state -- already using useMemo, not useState+useEffect
  // Filter root tree nodes by active workspace. "All" (null) = full tree.
  const filteredTree = useMemo(() => {
    if (!activeWorkspaceId) return projectOrder.tree
    const assignments = projectOrder.assignments ?? {}
    return projectOrder.tree.filter(node => assignments[node.id] === activeWorkspaceId)
  }, [projectOrder, activeWorkspaceId])

  // Effective project URI for each conversation: worktree URIs collapse to
  // parent (legacy support -- post-v7 migration these are already canonical
  // at the source, but the rewrite is cheap and protects unmigrated rows).
  // Exception: if the worktree URI itself is explicitly in the organized
  // tree, the user has placed it there intentionally -- don't move it.
  const effectiveProjectByConvId = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of structure) {
      const wt = parseWorktreeUri(s.project)
      const eff = wt && !treeProjects.has(s.project) ? wt.parentUri : s.project
      map.set(s.id, eff)
    }
    return map
  }, [structure, treeProjects])

  // Group conversation IDs by lineage host project.
  // Spawn lineage transcends project boundaries: a conversation whose root
  // (rootConversationId) lives in a different project is filed under the
  // root's project so the spawn chain stays visually together. The
  // conversation's own project gets a dimmed cross-project stub pointing
  // back to the root (rendered by `ProjectConversationGroup`).
  // A conversation with no rootConversationId, or whose root isn't visible
  // in `structure`, is filed under its own effective project.
  const { idsByProject, crossProjectStubsByProject } = useMemo(() => {
    const ids = new Map<string, string[]>()
    const stubs = new Map<string, Set<string>>()
    for (const s of structure) {
      const ownProject = effectiveProjectByConvId.get(s.id) || s.project
      const rootProject = s.rootConversationId ? effectiveProjectByConvId.get(s.rootConversationId) : undefined
      const hostProject = rootProject ?? ownProject
      const group = ids.get(hostProject) || []
      group.push(s.id)
      ids.set(hostProject, group)
      if (rootProject && rootProject !== ownProject && s.rootConversationId) {
        // Cross-project member: leave a dimmed pointer in the conversation's
        // own project that links back to the root group.
        const bag = stubs.get(ownProject) || new Set<string>()
        bag.add(s.rootConversationId)
        stubs.set(ownProject, bag)
      }
    }
    return { idsByProject: ids, crossProjectStubsByProject: stubs }
  }, [structure, effectiveProjectByConvId])

  // Filtered view: hide ended conversations from project groups when toggle is off.
  const visibleIdsByProject = useMemo(() => {
    if (showEnded) return idsByProject
    const map = new Map<string, string[]>()
    for (const [project, ids] of idsByProject) {
      const filtered = ids.filter(id => structureById.get(id)?.status !== 'ended')
      if (filtered.length > 0) map.set(project, filtered)
    }
    return map
  }, [idsByProject, showEnded, structureById])

  // Stable-array form of crossProjectStubsByProject so ProjectNode's memo can
  // shallow-compare without rebuilding from a Set each render. Sorted by
  // root conversation id for deterministic ordering.
  const stubIdsByProject = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [project, rootIds] of crossProjectStubsByProject) {
      map.set(project, Array.from(rootIds).sort())
    }
    return map
  }, [crossProjectStubsByProject])

  // Pinned projects not in tree (show even with 0 conversations)
  const pinnedNotInTree = useMemo(() => {
    const result: string[] = []
    for (const [uri, ps] of Object.entries(projectSettings)) {
      if (ps.pinned && !treeProjects.has(uri) && !visibleIdsByProject.has(uri)) {
        result.push(uri)
      }
    }
    return result
  }, [projectSettings, treeProjects, visibleIdsByProject])

  // Unorganized active conversations (uses visibleIdsByProject to respect showEnded filter).
  // Uses the same effective-project-key logic as idsByProject so worktree conversations
  // appear under their parent group rather than as a separate entry.
  const unorganized = useMemo(() => {
    const seen = new Set<string>()
    const result: Array<{ project: string; conversationIds: string[] }> = []
    for (const s of structure) {
      const effectiveProject = effectiveProjectByConvId.get(s.id) || s.project
      if (s.status !== 'ended' && !treeProjects.has(effectiveProject) && !seen.has(effectiveProject)) {
        seen.add(effectiveProject)
        const ids = visibleIdsByProject.get(effectiveProject) || []
        if (ids.length > 0) result.push({ project: effectiveProject, conversationIds: ids })
      }
    }
    result.sort((a, b) => {
      const aAllAdHoc = a.conversationIds.every(id => structureById.get(id)?.capabilities?.includes('ad-hoc'))
      const bAllAdHoc = b.conversationIds.every(id => structureById.get(id)?.capabilities?.includes('ad-hoc'))
      if (aAllAdHoc !== bAllAdHoc) return aAllAdHoc ? 1 : -1
      const aMax = Math.max(...a.conversationIds.map(id => structureById.get(id)?.startedAt ?? 0))
      const bMax = Math.max(...b.conversationIds.map(id => structureById.get(id)?.startedAt ?? 0))
      return bMax - aMax
    })
    return result
  }, [structure, treeProjects, visibleIdsByProject, effectiveProjectByConvId, structureById])

  // Inactive conversations (ended, not in tree, not in unorganized).
  // lastActivity is read lazily from the live store at sort time -- ended
  // conversations rarely tick, and excluding it from the structural selector
  // saves a ProjectList re-render on every WS message.
  const inactive = useMemo(() => {
    const activeProjects = new Set<string>()
    for (const s of structure) {
      if (s.status !== 'ended') activeProjects.add(s.project)
    }
    const byProject = new Map<string, ConversationStructure[]>()
    for (const s of structure) {
      const key = s.project
      if (s.status === 'ended' && !treeProjects.has(key) && !activeProjects.has(key)) {
        const group = byProject.get(key) || []
        group.push(s)
        byProject.set(key, group)
      }
    }
    const conversationsById = useConversationsStore.getState().conversationsById
    const lastActivityOf = (id: string) => conversationsById[id]?.lastActivity ?? 0
    return Array.from(byProject.values()).sort((a, b) => {
      const aMax = Math.max(...a.map(s => lastActivityOf(s.id)))
      const bMax = Math.max(...b.map(s => lastActivityOf(s.id)))
      return bMax - aMax
    })
  }, [structure, treeProjects])

  // Toggle group collapse
  function toggleGroup(groupId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      // collapsed-group set; orphan ids in the set are harmless
      // react-doctor-disable-next-line react-doctor/client-localstorage-no-version
      // collapsed-group set; orphan ids in the set are harmless
      // react-doctor-disable-next-line react-doctor/client-localstorage-no-version
      localStorage.setItem('collapsed-groups', JSON.stringify([...next]))
      return next
    })
  }

  // Scroll the selected conversation into view. Always safe to call -- block:'nearest'
  // is a no-op when the item is already fully visible (e.g. you just clicked it).
  // Pass {block:'center', behavior:'auto'} for explicit "locate" (mobile sheet open,
  // Crosshair button, CMD+P locate) so the landing is definitive and uncancellable.
  function scrollSelectedIntoView(opts?: ScrollIntoViewOptions) {
    if (!selectedConversationId) return
    requestAnimationFrame(() => {
      const el = findVisibleConversationEl(selectedConversationId)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', ...opts })
    })
  }

  // Pulse-glow the selected conversation to draw attention to it.
  function pulseSelected() {
    if (!selectedConversationId) return
    requestAnimationFrame(() => {
      const el = findVisibleConversationEl(selectedConversationId)
      if (el) {
        el.classList.remove('conversation-pulse')
        // Force reflow so re-adding the class restarts the animation
        void (el as HTMLElement).offsetWidth
        el.classList.add('conversation-pulse')
        setTimeout(() => el.classList.remove('conversation-pulse'), 1500)
      }
    })
  }

  // Selection changed: ALWAYS scroll into view, but only pulse for programmatic
  // selections (spawn, command-palette, deep-link, defaults). A direct click/touch
  // passes reason 'click' and is left silent -- you don't need a flourish on the
  // thing your finger is already on.
  useEffect(() => {
    scrollSelectedIntoView()
    if (useConversationsStore.getState().lastSelectReason !== 'click') pulseSelected()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [selectedConversationId])

  // External callers (locate button, CMD+P locate, mobile sheet open) always scroll + pulse.
  // Use center+auto so the landing is definitive and the user immediately sees their
  // conversation, not just a sliver of it pinned to the edge.
  useEffect(() => {
    function handleLocate() {
      scrollSelectedIntoView({ block: 'center', behavior: 'auto' })
      pulseSelected()
    }
    window.addEventListener('locate-conversation', handleLocate)
    return () => window.removeEventListener('locate-conversation', handleLocate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [selectedConversationId])

  // Rename group
  const handleRename = useCallback(
    (groupId: string, newName: string) => {
      function renameInTree(nodes: ProjectOrderNode[]): ProjectOrderNode[] {
        return nodes.map(n => {
          if (n.type === 'group' && n.id === groupId) return { ...n, name: newName }
          if (n.type === 'group') return { ...n, children: renameInTree(n.children) }
          return n
        })
      }
      const newOrder: ProjectOrder = { tree: renameInTree(projectOrder.tree) }
      useConversationsStore.getState().setProjectOrder(newOrder)
      saveProjectOrder(newOrder)
    },
    [projectOrder],
  )

  if (structure.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10">
        <pre className="text-xs mb-4">
          {`
  No conversations yet

  Start a conversation with:
  $ rclaude
`.trim()}
        </pre>
      </div>
    )
  }

  const hasOrganized = filteredTree.length > 0
  const isFiltered = activeWorkspaceId !== null
  // Project URI of the currently-selected conversation, looked up lazily
  // from the structural shape so we don't have to subscribe to conversationsById.
  // Strip profile so a `work@default` selection still highlights the project
  // node organized under the canonical `default` URI.
  const selectedProjectRaw = selectedConversationId
    ? structure.find(s => s.id === selectedConversationId)?.project
    : null
  const selectedProject = selectedProjectRaw

  return (
    <MaybeProfiler id="ProjectList">
      <div className="space-y-2 overflow-y-auto" data-perf-region="sidebar">
        <WorkspaceTabs />
        {filteredTree.map(node => {
          if (node.type === 'group') {
            const isCollapsed = collapsedGroups.has(node.id)
            return (
              <div key={node.id}>
                <GroupNode
                  group={node}
                  idsByProject={visibleIdsByProject}
                  collapsed={isCollapsed}
                  onToggle={() => toggleGroup(node.id)}
                  onRename={name => handleRename(node.id, name)}
                />
                {!isCollapsed ? (
                  <div className="space-y-1">
                    {node.children.map(child => {
                      if (child.type === 'group') return null
                      const childProject = child.id
                      const childIds = visibleIdsByProject.get(childProject)
                      if (!childIds || childIds.length === 0) {
                        if (projectSettings[projectIdentityKey(childProject)]?.pinned) {
                          return <PinnedProjectNode key={child.id} project={childProject} />
                        }
                        return null
                      }
                      return (
                        <ProjectNode
                          key={child.id}
                          project={childProject}
                          conversationIds={childIds}
                          crossProjectStubIds={stubIdsByProject.get(childProject)}
                        />
                      )
                    })}
                  </div>
                ) : // Peek: show selected conversation even when group is collapsed.
                // Use a per-id subscribed wrapper so the peek re-renders
                // independently of ProjectList.
                selectedConversationId && selectedProject && node.children.some(c => c.id === selectedProject) ? (
                  <div className="opacity-80">
                    <ConversationCompactPeek conversationId={selectedConversationId} />
                  </div>
                ) : null}
              </div>
            )
          }
          // Root-level conversation node
          const nodeProject = node.id
          const nodeIds = visibleIdsByProject.get(nodeProject)
          if (!nodeIds || nodeIds.length === 0) {
            if (projectSettings[projectIdentityKey(nodeProject)]?.pinned) {
              return <PinnedProjectNode key={node.id} project={nodeProject} />
            }
            return null
          }
          return (
            <ProjectNode
              key={node.id}
              project={nodeProject}
              conversationIds={nodeIds}
              crossProjectStubIds={stubIdsByProject.get(nodeProject)}
            />
          )
        })}

        {/* Unorganized section -- hidden when a workspace filter is active */}
        {!isFiltered && (unorganized.length > 0 || pinnedNotInTree.length > 0) && (
          <div>
            {hasOrganized && (
              <div className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-wider px-1 mb-1 flex items-center gap-2">
                <span>Unorganized</span>
                <span className="flex-1 h-px bg-border" />
              </div>
            )}
            <div className="space-y-1">
              {pinnedNotInTree.map(uri => (
                <PinnedProjectNode key={uri} project={uri} />
              ))}
              {unorganized.map(({ project, conversationIds }, i) => {
                // Insert separator before first ad-hoc-only group
                const isAllAdHoc = conversationIds.every(id => structureById.get(id)?.capabilities?.includes('ad-hoc'))
                const prevIsRegular =
                  i > 0 &&
                  !unorganized[i - 1].conversationIds.every(id =>
                    structureById.get(id)?.capabilities?.includes('ad-hoc'),
                  )
                const showAdHocSeparator = isAllAdHoc && (i === 0 || prevIsRegular)
                return (
                  <div key={project}>
                    {showAdHocSeparator && (
                      <div className="flex items-center gap-2 px-1 pt-2 pb-1">
                        <span className="flex-1 h-px bg-border" />
                        <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider">ad-hoc</span>
                        <span className="flex-1 h-px bg-border" />
                      </div>
                    )}
                    <ProjectNode
                      project={project}
                      conversationIds={conversationIds}
                      crossProjectStubIds={stubIdsByProject.get(project)}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Inactive section -- hidden when a workspace filter is active */}
        {!isFiltered && inactive.length > 0 && (
          <label className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => updatePrefs({ showInactiveByDefault: e.target.checked })}
              className="accent-primary"
            />
            show inactive ({inactive.length})
          </label>
        )}
        {!isFiltered &&
          showInactive &&
          inactive.map(group => <InactiveProjectItem key={group[0].project} conversationIds={group.map(s => s.id)} />)}
      </div>
    </MaybeProfiler>
  )
}
