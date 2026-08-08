import { useCallback } from 'react'
import { saveProjectTree } from '@/hooks/use-conversations'
import { MaybeProfiler } from './perf-profiler'
import { renameGroup } from './project-list/project-order-tree'
import { TreeNode } from './project-list/project-tree-nodes'
import { UnfilteredSections } from './project-list/unfiltered-sections'
import { useCollapsedGroups } from './project-list/use-collapsed-groups'
import { useProjectGroups } from './project-list/use-project-groups'
import { useProjectListStore } from './project-list/use-project-list-store'
import { WorkspaceTabs } from './project-list/workspace-tabs'

// ─── Main ProjectList ──────────────────────────────────────────────
//
// Scrolling the selected row into view is NOT this component's job -- it belongs
// to whoever owns the scroll container, which is `components/sidebar`. See
// `sidebar/use-sidebar-scroll.ts`. This used to live here and reach out through
// a document-wide querySelector to find "whichever copy is visible", back when
// two ProjectLists were mounted at once.

export function ProjectList() {
  const {
    structure,
    selectedConversationId,
    projectOrder,
    projectSettings,
    showEnded,
    showInactive,
    activeWorkspaceId,
    updatePrefs,
  } = useProjectListStore()
  const { collapsedGroups, toggleGroup } = useCollapsedGroups()

  const { structureById, filteredTree, visibleIdsByProject, stubIdsByProject, pinnedNotInTree, unorganized, inactive } =
    useProjectGroups(structure, projectOrder, projectSettings, showEnded, activeWorkspaceId)

  // Tree-only edit -- saveProjectTree carries the workspace fields over.
  const handleRename = useCallback(
    (groupId: string, name: string) => saveProjectTree(renameGroup(projectOrder.tree, groupId, name)),
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

  // Project URI of the selected conversation, read off the structural shape so
  // we never have to subscribe to conversationsById just to highlight a node.
  const selectedProject = selectedConversationId ? structure.find(s => s.id === selectedConversationId)?.project : null

  return (
    <MaybeProfiler id="ProjectList">
      {/* select-none: drag-select here only fights drag-to-reorder and smears the
          cards blue. Carve-outs: text fields (WebKit lets an inherited none swallow
          selection INSIDE an input, killing inline rename) and the per-project
          checklist, which opts back in on its own root. */}
      {/* No overflow here: the sidebar owns the one scroll container. A second
          nested scroller only made `scrollIntoView` ambiguous about which
          ancestor it was supposed to move. */}
      <div className="space-y-2 select-none [&_input]:select-text [&_textarea]:select-text">
        <WorkspaceTabs />
        {filteredTree.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            visibleIdsByProject={visibleIdsByProject}
            stubIdsByProject={stubIdsByProject}
            projectSettings={projectSettings}
            collapsedGroups={collapsedGroups}
            selectedConversationId={selectedConversationId}
            selectedProject={selectedProject}
            onToggleGroup={toggleGroup}
            onRenameGroup={handleRename}
          />
        ))}

        <UnfilteredSections
          isFiltered={activeWorkspaceId !== null}
          hasOrganized={filteredTree.length > 0}
          unorganized={unorganized}
          pinnedNotInTree={pinnedNotInTree}
          stubIdsByProject={stubIdsByProject}
          structureById={structureById}
          inactive={inactive}
          showInactive={showInactive}
          onShowInactiveChange={next => updatePrefs({ showInactiveByDefault: next })}
        />
      </div>
    </MaybeProfiler>
  )
}
