/**
 * Filter / sort / status / collapse state for the sheaf page.
 *
 * In-memory only (no persistence by design). Projects are collapsed by default
 * -- a projectUri is open only while present in `expanded`.
 */

import type { SheafProject, SheafStatus } from '@shared/sheaf-types'
import { useCallback, useMemo, useState } from 'react'
import { projectMatchesStatus, type SortKey, sortProjects } from './sheaf-derive'

export interface SheafFilters {
  filter: string
  setFilter: (s: string) => void
  clearFilter: () => void
  sort: SortKey
  setSort: (s: SortKey) => void
  statusFilter: Set<SheafStatus>
  toggleStatus: (s: SheafStatus) => void
  expanded: Set<string>
  toggleProject: (uri: string) => void
  anyExpanded: boolean
  toggleAll: () => void
  showLineage: boolean
  toggleLineage: () => void
  showRecaps: boolean
  toggleRecaps: () => void
  visibleProjects: SheafProject[]
  totalCount: number
  filtersActive: boolean
}

export function useSheafFilters(allProjects: SheafProject[]): SheafFilters {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortKey>('cost')
  const [statusFilter, setStatusFilter] = useState<Set<SheafStatus>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // View toggles -- both default on.
  const [showLineage, setShowLineage] = useState(true)
  const [showRecaps, setShowRecaps] = useState(true)

  const visibleProjects = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const filtered = allProjects.filter(p => {
      if (needle && !p.label.toLowerCase().includes(needle)) return false
      return projectMatchesStatus(p, statusFilter)
    })
    return sortProjects(filtered, sort)
  }, [allProjects, filter, statusFilter, sort])

  const clearFilter = useCallback(() => setFilter(''), [])

  const toggleProject = useCallback((uri: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(uri)) next.delete(uri)
      else next.add(uri)
      return next
    })
  }, [])

  const anyExpanded = visibleProjects.some(p => expanded.has(p.projectUri))
  const toggleAll = useCallback(() => {
    setExpanded(() => (anyExpanded ? new Set() : new Set(visibleProjects.map(p => p.projectUri))))
  }, [anyExpanded, visibleProjects])

  const toggleStatus = useCallback((s: SheafStatus) => {
    setStatusFilter(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }, [])

  const toggleLineage = useCallback(() => setShowLineage(v => !v), [])
  const toggleRecaps = useCallback(() => setShowRecaps(v => !v), [])

  const filtersActive = filter.trim().length > 0 || statusFilter.size > 0

  return {
    filter,
    setFilter,
    clearFilter,
    sort,
    setSort,
    statusFilter,
    toggleStatus,
    expanded,
    toggleProject,
    anyExpanded,
    toggleAll,
    showLineage,
    toggleLineage,
    showRecaps,
    toggleRecaps,
    visibleProjects,
    totalCount: allProjects.length,
    filtersActive,
  }
}
