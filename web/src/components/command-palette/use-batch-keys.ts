/**
 * Batch mode's keyboard layer: arrow-key row focus, space to toggle, `a` for
 * select-visible, `i` for invert.
 */

import { useCallback, useEffect } from 'react'
import { useKeyLayer } from '@/lib/key-layers'
import type { BatchSelection } from './use-batch-selection'

/** Typing in a field must never trigger a selection hotkey. */
export function ifNotTyping(run: () => void) {
  return (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    e.preventDefault()
    run()
  }
}

/** Step `delta` places through the focusable rows, clamped at both ends. */
export function nextFocus(focusable: number[], current: number, delta: number): number {
  if (focusable.length === 0) return current
  const cur = focusable.indexOf(current)
  const ordinal = cur === -1 ? 0 : Math.max(0, Math.min(focusable.length - 1, cur + delta))
  return focusable[ordinal] ?? 0
}

export function useBatchKeys({
  enabled,
  rowCount,
  focusableIndices,
  focusedIndex,
  setFocusedIndex,
  selection,
}: {
  enabled: boolean
  rowCount: number
  focusableIndices: number[]
  focusedIndex: number
  setFocusedIndex: (idx: number) => void
  selection: BatchSelection
}): void {
  // Clamp focus when the list shrinks under it.
  useEffect(() => {
    if (focusedIndex >= rowCount) setFocusedIndex(Math.max(0, rowCount - 1))
  }, [rowCount, focusedIndex, setFocusedIndex])

  const move = useCallback(
    (delta: number) => setFocusedIndex(nextFocus(focusableIndices, focusedIndex, delta)),
    [focusableIndices, focusedIndex, setFocusedIndex],
  )

  useKeyLayer(
    {
      ArrowDown: e => {
        e.preventDefault()
        move(1)
      },
      ArrowUp: e => {
        e.preventDefault()
        move(-1)
      },
      ' ': e => ifNotTyping(() => selection.toggleAt(focusedIndex, e.shiftKey))(e),
      a: ifNotTyping(selection.selectVisible),
      i: ifNotTyping(selection.invert),
    },
    { id: 'batch-palette', enabled },
  )
}
