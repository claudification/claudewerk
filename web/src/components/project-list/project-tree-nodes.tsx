import { projectIdentityKey } from '@shared/project-uri'
import type { ConversationStructure } from '@/hooks/use-conversations'
import type { ProjectOrderNode, ProjectSettings } from '@/lib/types'
import { ConversationCompactPeek } from './conversation-item'
import { GroupNode } from './conversation-sorting'
import { PinnedProjectNode, ProjectNode } from './project-node'

/**
 * The tree and unorganized sections of the sidebar list. Split out of
 * `ProjectList`, which was carrying its derivations, its collapse state and four
 * levels of nested JSX ternary in one 400-line component.
 */

export type TreeNodeProps = {
  node: ProjectOrderNode
  visibleIdsByProject: Map<string, string[]>
  stubIdsByProject: Map<string, string[]>
  projectSettings: Record<string, ProjectSettings>
  collapsedGroups: Set<string>
  selectedConversationId: string | null
  selectedProject: string | null | undefined
  onToggleGroup: (groupId: string) => void
  onRenameGroup: (groupId: string, name: string) => void
}

/** A project that has conversations renders a node; an empty one renders only if pinned. */
function ProjectOrPinned({
  project,
  ids,
  stubIds,
  projectSettings,
}: {
  project: string
  ids: string[] | undefined
  stubIds: string[] | undefined
  projectSettings: Record<string, ProjectSettings>
}) {
  if (!ids || ids.length === 0) {
    if (projectSettings[projectIdentityKey(project)]?.pinned) return <PinnedProjectNode project={project} />
    return null
  }
  return <ProjectNode project={project} conversationIds={ids} crossProjectStubIds={stubIds} />
}

export function TreeNode(props: TreeNodeProps) {
  const { node, visibleIdsByProject, stubIdsByProject, projectSettings } = props
  if (node.type !== 'group') {
    return (
      <ProjectOrPinned
        project={node.id}
        ids={visibleIdsByProject.get(node.id)}
        stubIds={stubIdsByProject.get(node.id)}
        projectSettings={projectSettings}
      />
    )
  }

  const collapsed = props.collapsedGroups.has(node.id)
  // Peek: a collapsed group still shows the SELECTED conversation, so the thing
  // you are looking at never vanishes just because its group is folded.
  const peeks =
    collapsed &&
    props.selectedConversationId &&
    props.selectedProject &&
    node.children.some(c => c.id === props.selectedProject)

  return (
    <div>
      <GroupNode
        group={node}
        idsByProject={visibleIdsByProject}
        collapsed={collapsed}
        onToggle={() => props.onToggleGroup(node.id)}
        onRename={name => props.onRenameGroup(node.id, name)}
      />
      {!collapsed && (
        <div className="space-y-1">
          {node.children.map(child =>
            child.type === 'group' ? null : (
              <ProjectOrPinned
                key={child.id}
                project={child.id}
                ids={visibleIdsByProject.get(child.id)}
                stubIds={stubIdsByProject.get(child.id)}
                projectSettings={projectSettings}
              />
            ),
          )}
        </div>
      )}
      {peeks && props.selectedConversationId && (
        <div className="opacity-80">
          <ConversationCompactPeek conversationId={props.selectedConversationId} />
        </div>
      )}
    </div>
  )
}

const isAdHocOnly = (ids: string[], structureById: Map<string, ConversationStructure>) =>
  ids.every(id => structureById.get(id)?.capabilities?.includes('ad-hoc'))

function SectionRule({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-2 pb-1">
      <span className="flex-1 h-px bg-border" />
      <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider">{label}</span>
      <span className="flex-1 h-px bg-border" />
    </div>
  )
}

export function UnorganizedSection({
  unorganized,
  pinnedNotInTree,
  stubIdsByProject,
  structureById,
  showHeading,
}: {
  unorganized: Array<{ project: string; conversationIds: string[] }>
  pinnedNotInTree: string[]
  stubIdsByProject: Map<string, string[]>
  structureById: Map<string, ConversationStructure>
  showHeading: boolean
}) {
  if (unorganized.length === 0 && pinnedNotInTree.length === 0) return null
  // The ad-hoc rule goes above the FIRST ad-hoc-only group, wherever the sort
  // put it -- they are sorted to the bottom, so this fires at most once.
  const ruleAt = unorganized.findIndex(g => isAdHocOnly(g.conversationIds, structureById))

  return (
    <div>
      {showHeading && (
        <div className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-wider px-1 mb-1 flex items-center gap-2">
          <span>Unorganized</span>
          <span className="flex-1 h-px bg-border" />
        </div>
      )}
      <div className="space-y-1">
        {pinnedNotInTree.map(uri => (
          <PinnedProjectNode key={uri} project={uri} />
        ))}
        {unorganized.map(({ project, conversationIds }, i) => (
          <div key={project}>
            {i === ruleAt && <SectionRule label="ad-hoc" />}
            <ProjectNode
              project={project}
              conversationIds={conversationIds}
              crossProjectStubIds={stubIdsByProject.get(project)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
