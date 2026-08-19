/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { ProjectOrderGroup, ProjectOrderNode } from '@/lib/types'
import { applyProjectDragEnd, findInTree, findParentGroup, removeFromTree } from './use-project-drag-drop'

const group: ProjectOrderNode = {
  id: 'group-a',
  type: 'group',
  name: 'A',
  children: [
    { id: 'p1', type: 'project' },
    { id: 'p2', type: 'project' },
  ],
}

const tree: ProjectOrderNode[] = [group, { id: 'p3', type: 'project' }]

describe('removeFromTree', () => {
  it('removes a top-level project node', () => {
    const out = removeFromTree(tree, 'p3')
    expect(out.find(n => n.id === 'p3')).toBeUndefined()
    expect(out.length).toBe(1)
  })

  it('removes a child from inside a group, leaving the group intact', () => {
    const out = removeFromTree(tree, 'p1')
    const g = out.find(n => n.id === 'group-a')
    expect(g).toBeDefined()
    if (g?.type !== 'group') throw new Error('expected group')
    expect(g.children.map(c => c.id)).toEqual(['p2'])
  })

  it('removes a whole top-level group when the group id is dropped', () => {
    const out = removeFromTree(tree, 'group-a')
    expect(out.find(n => n.id === 'group-a')).toBeUndefined()
    expect(out.length).toBe(1)
  })
})

describe('findInTree', () => {
  it('finds top-level node by id', () => {
    expect(findInTree(tree, 'p3')?.id).toBe('p3')
  })

  it('finds a group child by id', () => {
    expect(findInTree(tree, 'p1')?.id).toBe('p1')
  })

  it('returns null for missing id', () => {
    expect(findInTree(tree, 'missing')).toBeNull()
  })
})

describe('findParentGroup', () => {
  it('returns the group id for a group child', () => {
    expect(findParentGroup(tree, 'p1')).toBe('group-a')
  })

  it('returns null for a top-level project', () => {
    expect(findParentGroup(tree, 'p3')).toBeNull()
  })

  it('returns null for a missing id', () => {
    expect(findParentGroup(tree, 'missing')).toBeNull()
  })
})

describe('applyProjectDragEnd', () => {
  const groupB: ProjectOrderGroup = {
    id: 'group-b',
    type: 'group',
    name: 'B',
    children: [{ id: 'p4', type: 'project' }],
  }
  const t: ProjectOrderNode[] = [group, groupB, { id: 'p3', type: 'project' }]

  it('returns null for a no-op (no over, or same id)', () => {
    expect(applyProjectDragEnd(t, 'group-a', null)).toBeNull()
    expect(applyProjectDragEnd(t, 'p1', 'p1')).toBeNull()
  })

  it('reorders two root groups', () => {
    const out = applyProjectDragEnd(t, 'group-b', 'group-a')
    expect(out?.map(n => n.id)).toEqual(['group-b', 'group-a', 'p3'])
  })

  it('moves a project into a group when dropped on the group header', () => {
    const out = applyProjectDragEnd(t, 'p3', 'group-a')
    const g = out?.find(n => n.id === 'group-a') as ProjectOrderGroup
    expect(g.children.map(c => c.id)).toEqual(['p1', 'p2', 'p3'])
    expect(out?.some(n => n.id === 'p3')).toBe(false)
  })

  it('moves a project between groups when dropped on a sibling child', () => {
    const out = applyProjectDragEnd(t, 'p4', 'p1')
    const a = out?.find(n => n.id === 'group-a') as ProjectOrderGroup
    const b = out?.find(n => n.id === 'group-b') as ProjectOrderGroup
    expect(a.children.map(c => c.id)).toEqual(['p4', 'p1', 'p2'])
    expect(b.children.map(c => c.id)).toEqual([])
  })

  it('ungroups a project via the __ungrouped__ sentinel', () => {
    const out = applyProjectDragEnd(t, 'p1', '__ungrouped__')
    const a = out?.find(n => n.id === 'group-a') as ProjectOrderGroup
    expect(a.children.map(c => c.id)).toEqual(['p2'])
  })

  it('pins an unorganized project into a group by dropping on a child', () => {
    const out = applyProjectDragEnd(t, 'newProj', 'p2')
    const a = out?.find(n => n.id === 'group-a') as ProjectOrderGroup
    expect(a.children.map(c => c.id)).toEqual(['p1', 'newProj', 'p2'])
  })

  it('does not mutate the input tree', () => {
    const snapshot = JSON.stringify(t)
    applyProjectDragEnd(t, 'p4', 'p1')
    expect(JSON.stringify(t)).toBe(snapshot)
  })
})
