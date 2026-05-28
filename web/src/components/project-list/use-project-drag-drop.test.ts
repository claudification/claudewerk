import { describe, expect, it } from 'vitest'
import type { ProjectOrderNode } from '@/lib/types'
import { findInTree, findParentGroup, removeFromTree } from './use-project-drag-drop'

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
