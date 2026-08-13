import { describe, expect, it } from 'vitest'
import { planDrag } from './use-workspace-dnd'

const WS = ['ws-1', 'ws-2', 'ws-3']
const MEMBERS = ['claude:///a', 'claude:///b', 'claude:///c']

describe('planDrag (one DndContext, two sortable lists)', () => {
  it('routes a workspace id to the rail and returns the new workspace order', () => {
    expect(planDrag(WS, MEMBERS, 'ws-3', 'ws-1')).toEqual({ list: 'rail', ids: ['ws-3', 'ws-1', 'ws-2'] })
  })

  it('routes a project uri to the members list', () => {
    expect(planDrag(WS, MEMBERS, 'claude:///c', 'claude:///a')).toEqual({
      list: 'members',
      ids: ['claude:///c', 'claude:///a', 'claude:///b'],
    })
  })

  it('is a no-op when dropped on itself', () => {
    expect(planDrag(WS, MEMBERS, 'ws-1', 'ws-1')).toBeNull()
  })

  it('is a no-op when dropped outside any sortable', () => {
    expect(planDrag(WS, MEMBERS, 'ws-1', null)).toBeNull()
  })

  it('is a no-op when the drop target belongs to the OTHER list', () => {
    // Dragging a workspace onto a project row must not reorder either list.
    expect(planDrag(WS, MEMBERS, 'ws-1', 'claude:///a')).toBeNull()
  })

  it('is a no-op with no workspace selected (empty members list)', () => {
    expect(planDrag(WS, [], 'claude:///a', 'claude:///b')).toBeNull()
  })
})
