import type { ConversationStructure } from '@/hooks/use-conversations'
import { InactiveProjectItem } from './conversation-item'
import { UnorganizedSection } from './project-tree-nodes'

/**
 * The two sections below the organized tree -- unorganized projects, then the
 * inactive roll-up. Both are hidden whenever a workspace filter is active, and
 * that ONE condition is checked here rather than repeated at three call sites
 * inside `ProjectList`'s JSX.
 */
export function UnfilteredSections({
  isFiltered,
  hasOrganized,
  unorganized,
  pinnedNotInTree,
  stubIdsByProject,
  structureById,
  inactive,
  showInactive,
  onShowInactiveChange,
}: {
  isFiltered: boolean
  hasOrganized: boolean
  unorganized: Array<{ project: string; conversationIds: string[] }>
  pinnedNotInTree: string[]
  stubIdsByProject: Map<string, string[]>
  structureById: Map<string, ConversationStructure>
  inactive: ConversationStructure[][]
  showInactive: boolean
  onShowInactiveChange: (next: boolean) => void
}) {
  if (isFiltered) return null

  return (
    <>
      <UnorganizedSection
        unorganized={unorganized}
        pinnedNotInTree={pinnedNotInTree}
        stubIdsByProject={stubIdsByProject}
        structureById={structureById}
        showHeading={hasOrganized}
      />

      {inactive.length > 0 && (
        <label className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => onShowInactiveChange(e.target.checked)}
            className="accent-primary"
          />
          show inactive ({inactive.length})
        </label>
      )}

      {showInactive &&
        inactive.map(group => <InactiveProjectItem key={group[0].project} conversationIds={group.map(s => s.id)} />)}
    </>
  )
}
