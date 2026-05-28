import type { DragEndEvent } from '@dnd-kit/core'
import { useCallback } from 'react'
import { saveProjectOrder, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, ProjectOrderGroup, ProjectOrderNode } from '@/lib/types'
import { haptic } from '@/lib/utils'

export function removeFromTree(tree: ProjectOrderNode[], id: string): ProjectOrderNode[] {
  const out: ProjectOrderNode[] = []
  for (const n of tree) {
    if (n.id === id) continue
    if (n.type === 'group') out.push({ ...n, children: n.children.filter(c => c.id !== id) })
    else out.push(n)
  }
  return out
}

export function findInTree(tree: ProjectOrderNode[], id: string): ProjectOrderNode | null {
  for (const n of tree) {
    if (n.id === id) return n
    if (n.type === 'group') {
      const found = n.children.find(c => c.id === id)
      if (found) return found
    }
  }
  return null
}

export function findParentGroup(tree: ProjectOrderNode[], id: string): string | null {
  for (const node of tree) {
    if (node.type === 'group' && node.children.some(c => c.id === id)) return node.id
  }
  return null
}

function persistTree(tree: ProjectOrderNode[]): void {
  const newOrder: ProjectOrder = { tree }
  useConversationsStore.getState().setProjectOrder(newOrder)
  saveProjectOrder(newOrder)
}

function handleNewGroupDrop(tree: ProjectOrderNode[], draggedId: string): boolean {
  const name = window.prompt('Group name:')
  if (!name?.trim()) return false
  const groupId = `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
  const newTree = removeFromTree(tree, draggedId)
  const conversationNode = draggedId.startsWith('group-')
    ? tree.find(n => n.id === draggedId)
    : { id: draggedId, type: 'project' as const }
  if (conversationNode) {
    newTree.push({
      id: groupId,
      type: 'group',
      name: name.trim(),
      children: [conversationNode.type === 'group' ? conversationNode : { id: draggedId, type: 'project' }],
    })
  }
  persistTree(newTree)
  return true
}

function reorderGroups(tree: ProjectOrderNode[], draggedId: string, overId: string): void {
  const newTree = [...tree]
  const fromIdx = newTree.findIndex(n => n.id === draggedId)
  const toIdx = newTree.findIndex(n => n.id === overId)
  if (fromIdx === -1 || toIdx === -1) return
  const [moved] = newTree.splice(fromIdx, 1)
  newTree.splice(toIdx, 0, moved)
  persistTree(newTree)
}

function dropIntoGroup(tree: ProjectOrderNode[], draggedId: string, overId: string): void {
  const newTree = removeFromTree(tree, draggedId)
  const targetGroup = newTree.find(n => n.id === overId && n.type === 'group') as ProjectOrderGroup | undefined
  if (targetGroup) {
    targetGroup.children.push({ id: draggedId, type: 'project' })
  }
  persistTree(newTree)
}

function pinUnorganized(tree: ProjectOrderNode[], draggedId: string, overId: string): void {
  const overParent = findParentGroup(tree, overId)
  const newTree = [...tree]
  if (overParent) {
    const group = newTree.find(n => n.id === overParent && n.type === 'group') as ProjectOrderGroup | undefined
    if (group) {
      const idx = group.children.findIndex(c => c.id === overId)
      group.children.splice(idx >= 0 ? idx : group.children.length, 0, { id: draggedId, type: 'project' })
    }
  } else {
    const idx = newTree.findIndex(n => n.id === overId)
    newTree.splice(idx >= 0 ? idx : newTree.length, 0, { id: draggedId, type: 'project' })
  }
  persistTree(newTree)
}

function reorderWithinTree(tree: ProjectOrderNode[], draggedId: string, overId: string): void {
  const newTree = removeFromTree(tree, draggedId)
  const origNode = findInTree(tree, draggedId)
  const nodeToInsert = origNode || ({ id: draggedId, type: 'project' } as ProjectOrderNode)
  const overParent = findParentGroup(tree, overId)
  if (overParent) {
    const group = newTree.find(n => n.id === overParent && n.type === 'group') as ProjectOrderGroup | undefined
    if (group) {
      const idx = group.children.findIndex(c => c.id === overId)
      group.children.splice(idx >= 0 ? idx : group.children.length, 0, nodeToInsert)
    }
  } else {
    const idx = newTree.findIndex(n => n.id === overId)
    newTree.splice(idx >= 0 ? idx : newTree.length, 0, nodeToInsert)
  }
  persistTree(newTree)
}

export function useProjectDragDrop({
  tree,
  setIsDragging,
}: {
  tree: ProjectOrderNode[]
  setIsDragging: (next: boolean) => void
}): (event: DragEndEvent) => void {
  return useCallback(
    (event: DragEndEvent) => {
      setIsDragging(false)
      const { active, over } = event
      if (!over || active.id === over.id) return
      haptic('tick')

      const draggedId = active.id as string
      const overId = over.id as string

      if (overId === '__new_group__') {
        handleNewGroupDrop(tree, draggedId)
        return
      }

      const overIsGroup = overId.startsWith('group-')
      const draggedIsGroup = draggedId.startsWith('group-')
      const draggedIsInTree = tree.some(n => n.id === draggedId) || findParentGroup(tree, draggedId) !== null
      const overIsInTree = tree.some(n => n.id === overId) || findParentGroup(tree, overId) !== null

      if (draggedIsGroup && overIsGroup) {
        reorderGroups(tree, draggedId, overId)
      } else if (overIsGroup && !draggedIsGroup) {
        dropIntoGroup(tree, draggedId, overId)
      } else if (overIsInTree && !draggedIsInTree) {
        pinUnorganized(tree, draggedId, overId)
      } else if (draggedIsInTree && !overIsInTree) {
        const newTree = removeFromTree(tree, draggedId)
        persistTree(newTree)
      } else if (draggedIsInTree && overIsInTree) {
        reorderWithinTree(tree, draggedId, overId)
      }
    },
    [tree, setIsDragging],
  )
}
