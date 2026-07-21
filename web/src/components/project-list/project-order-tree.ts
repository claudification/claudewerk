/**
 * Pure project-order tree edits behind the "Move to group" menu.
 *
 * Kept out of the menu component so the tree rules -- which are fiddly, and where
 * a mistake silently reorders someone's sidebar -- can be tested directly.
 */

import type { ProjectOrderGroup, ProjectOrderNode } from '@/lib/types'

/** Move `project` into `groupId`, removing it from every other group + the root. */
export function moveIntoGroup(tree: ProjectOrderNode[], project: string, groupId: string): ProjectOrderNode[] {
  const moved = tree.map(node => {
    if (node.type !== 'group') return node
    const filtered = { ...node, children: node.children.filter(c => c.id !== project) }
    if (node.id !== groupId) return filtered
    return { ...filtered, children: [...filtered.children, { id: project, type: 'project' as const }] }
  })
  return moved.filter(n => n.id !== project)
}

/** Pull `project` out of every group, leaving it at the root exactly once. */
export function removeFromGroups(tree: ProjectOrderNode[], project: string): ProjectOrderNode[] {
  const stripped = tree.map(node =>
    node.type === 'group' ? { ...node, children: node.children.filter(c => c.id !== project) } : node,
  )
  if (stripped.some(n => n.id === project)) return stripped
  return [...stripped, { id: project, type: 'project' as const }]
}

/** Slug for a user-typed group name. Timestamp keeps same-named groups distinct. */
export function groupIdFor(name: string, now: number): string {
  return `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${now}`
}

/** Create a new group holding just `project`, removing it from wherever it was. */
export function createGroupWith(
  tree: ProjectOrderNode[],
  project: string,
  name: string,
  now: number,
): ProjectOrderNode[] {
  const rest: ProjectOrderNode[] = []
  for (const node of tree) {
    if (node.id === project) continue
    if (node.type === 'group') rest.push({ ...node, children: node.children.filter(c => c.id !== project) })
    else rest.push(node)
  }
  const group: ProjectOrderGroup = {
    id: groupIdFor(name, now),
    type: 'group',
    name: name.trim(),
    children: [{ id: project, type: 'project' }],
  }
  return [...rest, group]
}

/** The confirm() text for the project menu's bulk terminate. */
export function terminateAllSummary(activeCount: number, endedCount: number): string {
  return (
    `Terminate ALL ${activeCount} running conversation(s) in this project?` +
    (endedCount > 0 ? `\n\nAlso dismisses ${endedCount} ended conversation(s).` : '') +
    '\n\nRunning agents will be killed. This cannot be undone.'
  )
}
