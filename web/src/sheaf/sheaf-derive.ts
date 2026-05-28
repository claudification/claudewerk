/**
 * Pure derived-list helpers for the sheaf page: window/sort option tables,
 * forest traversal, status matching, sorting, and a keyboard-target guard.
 * No React, no side effects.
 */

import type { SheafNode, SheafProject, SheafStatus } from '@shared/sheaf-types'

export type SortKey = 'cost' | 'activity' | 'name' | 'convs'

export const WINDOW_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
]

export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'cost', label: 'cost' },
  { value: 'activity', label: 'activity' },
  { value: 'name', label: 'name' },
  { value: 'convs', label: 'convs' },
]

function eachNode(nodes: SheafNode[], fn: (n: SheafNode) => void): void {
  for (const n of nodes) {
    fn(n)
    eachNode(n.children, fn)
  }
}

/** A project is included if it holds >=1 conversation in the selected statuses. */
export function projectMatchesStatus(p: SheafProject, set: Set<SheafStatus>): boolean {
  if (set.size === 0) return true
  let found = false
  eachNode(p.forest, n => {
    if (set.has(n.status)) found = true
  })
  return found
}

/** Most-recent end-or-now across the whole forest. Running convs float to top. */
function latestActivity(p: SheafProject): number {
  let max = 0
  eachNode(p.forest, n => {
    const end = n.endedAt ?? n.startedAt + n.durationMs
    if (end > max) max = end
  })
  return max
}

export function sortProjects(projects: SheafProject[], sort: SortKey): SheafProject[] {
  const copy = [...projects]
  switch (sort) {
    case 'name':
      copy.sort((a, b) => a.label.localeCompare(b.label))
      break
    case 'convs':
      copy.sort((a, b) => b.totals.convCount - a.totals.convCount)
      break
    case 'activity':
      copy.sort((a, b) => latestActivity(b) - latestActivity(a))
      break
    default:
      copy.sort((a, b) => b.totals.cost.amount - a.totals.cost.amount)
  }
  return copy
}

/** Flatten a spawn forest into a single node list, newest-started first. */
export function flattenForest(forest: SheafNode[]): SheafNode[] {
  const out: SheafNode[] = []
  eachNode(forest, n => out.push(n))
  out.sort((a, b) => b.startedAt - a.startedAt)
  return out
}

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}
