import type { ConversationStructure } from '@/hooks/use-conversations'
import { UnorganizedSection } from './project-tree-nodes'

/**
 * The section below the organized tree -- unorganized projects. Hidden whenever
 * a workspace filter is active, and that ONE condition is checked here rather
 * than repeated at the call sites inside `ProjectList`'s JSX.
 *
 * There used to be a second section here: an "inactive" roll-up of projects
 * whose every conversation had ended, behind a `show inactive` checkbox. It is
 * gone by decree -- the sidebar lists projects and LIVE conversations, nothing
 * else. With thousands of accumulated sessions, any surface that can reveal
 * ended ones overflows the list. Do not add it back.
 */
export function UnfilteredSections({
  isFiltered,
  hasOrganized,
  unorganized,
  pinnedNotInTree,
  stubIdsByProject,
  structureById,
}: {
  isFiltered: boolean
  hasOrganized: boolean
  unorganized: Array<{ project: string; conversationIds: string[] }>
  pinnedNotInTree: string[]
  stubIdsByProject: Map<string, string[]>
  structureById: Map<string, ConversationStructure>
}) {
  if (isFiltered) return null

  return (
    <UnorganizedSection
      unorganized={unorganized}
      pinnedNotInTree={pinnedNotInTree}
      stubIdsByProject={stubIdsByProject}
      structureById={structureById}
      showHeading={hasOrganized}
    />
  )
}
