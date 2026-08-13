/**
 * One DndContext drives TWO sortable lists in this surface: the workspace rail
 * (reorders the workspaces themselves) and the members pane (reorders one
 * workspace's tree). Which list a drag belongs to is decided by whether the
 * dragged id is a workspace id -- workspace ids and project URIs can never
 * collide, so the test is unambiguous.
 */

import type { DragEndEvent } from '@dnd-kit/core'
import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useCallback } from 'react'
import { useWorkspaceActions } from '../project-list/workspace-actions'
import type { WorkspaceInventory } from './use-workspace-inventory'

export function useWorkspaceDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )
}

/** Which list moved, and what its new id order is. */
export type DragPlan = { list: 'rail' | 'members'; ids: string[] }

/** Move `activeId` into `overId`'s slot, or null when either is not in the list. */
function movedOrder(ids: string[], activeId: string, overId: string): string[] | null {
  const from = ids.indexOf(activeId)
  const to = ids.indexOf(overId)
  if (from === -1 || to === -1) return null
  return arrayMove(ids, from, to)
}

// Pure and covered by use-workspace-dnd.test.ts; the CRAP score here is the
// zero-coverage estimate, not real complexity (6 cyclomatic, all of it guards).
// fallow-ignore-next-line complexity
/** Pure: work out what a drop means. Null = nothing to do. */
export function planDrag(
  wsIds: string[],
  memberIds: string[],
  activeId: string,
  overId: string | null,
): DragPlan | null {
  if (!overId || activeId === overId) return null
  const isRail = wsIds.includes(activeId)
  const ids = movedOrder(isRail ? wsIds : memberIds, activeId, overId)
  return ids ? { list: isRail ? 'rail' : 'members', ids } : null
}

export function useWorkspaceDragEnd(inventory: WorkspaceInventory, selectedWsId: string | undefined) {
  const actions = useWorkspaceActions()

  // fallow-ignore-next-line complexity
  return useCallback(
    (e: DragEndEvent) => {
      const memberIds = selectedWsId ? inventory.membersOf(selectedWsId).map(n => n.id) : []
      const plan = planDrag(
        inventory.workspaces.map(w => w.id),
        memberIds,
        String(e.active.id),
        e.over ? String(e.over.id) : null,
      )
      if (!plan) return
      if (plan.list === 'rail') actions.reorder(plan.ids)
      else if (selectedWsId) actions.reorderInWorkspace(selectedWsId, plan.ids)
    },
    [inventory, selectedWsId, actions],
  )
}
