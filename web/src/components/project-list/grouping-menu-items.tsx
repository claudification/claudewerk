/**
 * "Move to group" / "New group…" menu items, plus the project-order edits behind
 * them. Shared by the conversation, project and pinned-project menus, which is
 * why it lives apart from any one of them.
 */

import { ContextMenu } from 'radix-ui'
import { saveProjectOrder, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, ProjectOrderGroup } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { menuContentClass, menuItemClass, menuSeparatorClass } from './menu-shared'
import { createGroupWith, moveIntoGroup, removeFromGroups } from './project-order-tree'

/** Grouping actions that operate on a project key. */
function useProjectGroupingActions(project: string) {
  const rawProjectOrder = useConversationsStore(s => s.projectOrder) as ProjectOrder | null
  const projectOrder = rawProjectOrder?.tree ? rawProjectOrder : { tree: [] }
  const groups = projectOrder.tree.filter((n): n is ProjectOrderGroup => n.type === 'group')

  // The tree edits themselves are pure and live in project-order-tree.ts; this
  // hook only supplies the current tree, the haptic, and the save.
  function moveToGroup(groupId: string) {
    haptic('tap')
    saveProjectOrder({ tree: moveIntoGroup(projectOrder.tree, project, groupId) })
  }

  function ungroup() {
    haptic('tap')
    saveProjectOrder({ tree: removeFromGroups(projectOrder.tree, project) })
  }

  function createGroupAndMove() {
    const name = prompt('Group name:')
    if (!name?.trim()) return
    haptic('tap')
    saveProjectOrder({ tree: createGroupWith(projectOrder.tree, project, name, Date.now()) })
  }

  return { groups, moveToGroup, ungroup, createGroupAndMove }
}

export function GroupingMenuItems({ project }: { project: string }) {
  const { groups, moveToGroup, ungroup, createGroupAndMove } = useProjectGroupingActions(project)
  return (
    <>
      {groups.length > 0 && (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={menuItemClass}>
            Move to <span className="ml-auto text-muted-foreground">{'▸'}</span>
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={menuContentClass}>
              {groups.map(g => (
                <ContextMenu.Item key={g.id} className={menuItemClass} onSelect={() => moveToGroup(g.id)}>
                  {g.name}
                </ContextMenu.Item>
              ))}
              <ContextMenu.Separator className={menuSeparatorClass} />
              <ContextMenu.Item className={menuItemClass} onSelect={ungroup}>
                Unpin (no group)
              </ContextMenu.Item>
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      )}
      <ContextMenu.Item className={menuItemClass} onSelect={createGroupAndMove}>
        New group…
      </ContextMenu.Item>
    </>
  )
}
