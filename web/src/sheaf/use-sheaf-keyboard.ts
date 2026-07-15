/**
 * Sheaf keyboard shortcuts (active only while the surface is INLINE -- the
 * managed modal stays mounted when closed/docked, and a detached window has its
 * own document so main-window listeners would be wrong there):
 *   /   focus the filter input (unless already typing in a field)
 *   r   reload (ignored while typing in the filter)
 * Escape is owned by the Radix Dialog (closes the modal).
 */

import { type RefObject, useEffect } from 'react'
import { isEditableTarget } from './sheaf-derive'

interface KeyboardOpts {
  filterRef: RefObject<HTMLInputElement | null>
  reload: () => void
  /** True only while the modal renders inline. */
  active: boolean
}

const isSlashFocus = (e: KeyboardEvent): boolean => e.key === '/' && !isEditableTarget(e.target)

// fallow-ignore-next-line complexity
const isReloadKey = (e: KeyboardEvent): boolean =>
  e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)

export function useSheafKeyboard({ filterRef, reload, active }: KeyboardOpts): void {
  useEffect(() => {
    if (!active) return
    function onKey(e: KeyboardEvent) {
      if (isSlashFocus(e)) {
        e.preventDefault()
        filterRef.current?.focus()
        return
      }
      if (isReloadKey(e)) reload()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filterRef, reload, active])
}
