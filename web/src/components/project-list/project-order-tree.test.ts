/**
 * Project-order tree edits. These reorder the user's sidebar, and every failure
 * mode here is silent -- a project that vanishes from the tree or gets listed
 * twice looks like a rendering glitch, not a data bug.
 */

import { expect, test } from 'vitest'
import type { ProjectOrderGroup, ProjectOrderNode } from '@/lib/types'
import { createGroupWith, groupIdFor, moveIntoGroup, removeFromGroups, terminateAllSummary } from './project-order-tree'

const proj = (id: string): ProjectOrderNode => ({ id, type: 'project' })
const group = (id: string, children: string[]): ProjectOrderGroup => ({
  id,
  type: 'group',
  name: id,
  children: children.map(proj),
})

test('moveIntoGroup adds to the target and removes from the root', () => {
  const tree = [group('g1', []), proj('p')]
  const out = moveIntoGroup(tree, 'p', 'g1')
  expect(out).toHaveLength(1)
  expect((out[0] as ProjectOrderGroup).children.map(c => c.id)).toEqual(['p'])
})

test('moveIntoGroup pulls the project out of any other group first', () => {
  const tree = [group('g1', ['p']), group('g2', [])]
  const out = moveIntoGroup(tree, 'p', 'g2') as ProjectOrderGroup[]
  expect(out.find(g => g.id === 'g1')?.children).toEqual([])
  expect(out.find(g => g.id === 'g2')?.children.map(c => c.id)).toEqual(['p'])
})

test('moveIntoGroup never duplicates the project', () => {
  const tree = [group('g1', ['p']), proj('p')]
  const out = moveIntoGroup(tree, 'p', 'g1') as ProjectOrderGroup[]
  const occurrences = out.flatMap(n => (n.type === 'group' ? n.children.map(c => c.id) : [n.id]))
  expect(occurrences.filter(id => id === 'p')).toHaveLength(1)
})

test('removeFromGroups leaves the project at the root exactly once', () => {
  const out = removeFromGroups([group('g1', ['p']), group('g2', ['p'])], 'p')
  expect(out.filter(n => n.id === 'p')).toHaveLength(1)
  for (const n of out) if (n.type === 'group') expect(n.children).toEqual([])
})

test('removeFromGroups does not add a second root entry when one exists', () => {
  const out = removeFromGroups([group('g1', ['p']), proj('p')], 'p')
  expect(out.filter(n => n.id === 'p')).toHaveLength(1)
})

test('createGroupWith moves the project into a fresh group', () => {
  const out = createGroupWith([group('g1', ['p']), proj('other')], 'p', 'My Group', 1234)
  const created = out.find(n => n.type === 'group' && n.name === 'My Group') as ProjectOrderGroup
  expect(created.children.map(c => c.id)).toEqual(['p'])
  expect((out.find(n => n.id === 'g1') as ProjectOrderGroup).children).toEqual([])
  expect(out.some(n => n.id === 'other')).toBe(true)
})

test('groupIdFor slugs the name and stays unique per timestamp', () => {
  expect(groupIdFor('  My Cool Group ', 42)).toBe('group-my-cool-group-42')
  expect(groupIdFor('X', 1)).not.toBe(groupIdFor('X', 2))
})

test('terminateAllSummary mentions ended conversations only when there are any', () => {
  expect(terminateAllSummary(3, 0)).toContain('ALL 3 running')
  expect(terminateAllSummary(3, 0)).not.toContain('Also dismisses')
  expect(terminateAllSummary(3, 2)).toContain('Also dismisses 2 ended')
})
