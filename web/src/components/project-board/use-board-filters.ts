/**
 * Everything that narrows the board: text, tags, priority, and the epic the
 * ribbon has selected.
 *
 * Pulled out of `ProjectBoard` because eight pieces of filter state and five
 * callbacks sitting in the same component as the data fetch, the modals and the
 * drag handlers is what made that component a god-file in the first place.
 * Filtering is one job; it gets one hook.
 */

import type { ProjectTaskMeta } from '@shared/project-task-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { publishEpicFocus } from '@/lib/cards/epic-focus'
import { haptic } from '@/lib/utils'

function matchesTextFilter(query: string, task: ProjectTaskMeta): boolean {
  if (!query) return true
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const title = task.title.toLowerCase()
  return terms.every(term => title.includes(term))
}

/** Unique tags across all tasks, most frequent first. */
function tagFrequencies(tasks: ProjectTaskMeta[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const tag of task.tags) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

/**
 * An epic filter keeps the epic's OWN card, not just its children. Dropping it
 * would filter the board to "this epic" and then hide the epic, which reads as
 * a card having gone missing.
 */
function matchesEpic(selectedEpic: string | null, task: ProjectTaskMeta): boolean {
  if (!selectedEpic) return true
  return task.epic === selectedEpic || task.slug === selectedEpic
}

export function useBoardFilters(tasks: ProjectTaskMeta[]) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [selectedPriority, setSelectedPriority] = useState<string | null>(null)
  const [selectedEpic, setSelectedEpic] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Tell Quick Task which epic is on screen, so a capture taken while an epic
  // is open inherits it. Clearing on unmount is the important half: a closed
  // board that kept donating a stale epic would mis-file every later capture.
  useEffect(() => {
    publishEpicFocus(selectedEpic)
    return () => publishEpicFocus(null)
  }, [selectedEpic])

  const tagFreqs = useMemo(() => tagFrequencies(tasks), [tasks])

  const filtered = useMemo(
    () =>
      tasks.filter(task => {
        if (!matchesTextFilter(searchQuery, task)) return false
        if (selectedTags.size > 0 && !task.tags.some(t => selectedTags.has(t))) return false
        if (selectedPriority && task.priority !== selectedPriority) return false
        return matchesEpic(selectedEpic, task)
      }),
    [tasks, searchQuery, selectedTags, selectedPriority, selectedEpic],
  )

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }, [])

  const togglePriority = useCallback((p: string) => setSelectedPriority(prev => (prev === p ? null : p)), [])

  const clear = useCallback(() => {
    setSearchQuery('')
    setSelectedTags(new Set())
    setSelectedPriority(null)
    setSelectedEpic(null)
    haptic('tap')
  }, [])

  const toggleSearch = useCallback(() => {
    setSearchOpen(prev => {
      if (!prev) requestAnimationFrame(() => searchRef.current?.focus())
      else setSearchQuery('')
      return !prev
    })
  }, [])

  // Cmd+F / Ctrl+F opens the filter and focuses it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const active = !!(searchQuery.trim() || selectedTags.size > 0 || selectedPriority || selectedEpic)

  return {
    filtered,
    tagFreqs,
    active,
    searchQuery,
    setSearchQuery,
    searchOpen,
    toggleSearch,
    searchRef,
    selectedTags,
    toggleTag,
    selectedPriority,
    togglePriority,
    selectedEpic,
    setSelectedEpic,
    clear,
  }
}
