/**
 * Sheaf page keyboard shortcuts:
 *   /        focus the filter input (unless already typing in a field)
 *   Escape   clear an active filter first, then exit the page
 *   r        reload (ignored while typing in the filter)
 */

import { type RefObject, useEffect } from 'react'
import { isEditableTarget } from './sheaf-derive'

function backToDashboard() {
  window.location.hash = ''
}

interface KeyboardOpts {
  filterRef: RefObject<HTMLInputElement | null>
  filter: string
  clearFilter: () => void
  reload: () => void
}

function handleEscape(filterRef: RefObject<HTMLInputElement | null>, filter: string, clearFilter: () => void): void {
  if (document.activeElement === filterRef.current && filter.length > 0) {
    clearFilter()
    filterRef.current?.blur()
    return
  }
  backToDashboard()
}

const isSlashFocus = (e: KeyboardEvent): boolean => e.key === '/' && !isEditableTarget(e.target)

// fallow-ignore-next-line complexity
const isReloadKey = (e: KeyboardEvent): boolean =>
  e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)

export function useSheafKeyboard({ filterRef, filter, clearFilter, reload }: KeyboardOpts): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isSlashFocus(e)) {
        e.preventDefault()
        filterRef.current?.focus()
        return
      }
      if (e.key === 'Escape') {
        handleEscape(filterRef, filter, clearFilter)
        return
      }
      if (isReloadKey(e)) reload()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filterRef, filter, clearFilter, reload])
}
