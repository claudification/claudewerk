import { useCallback, useEffect, useState } from 'react'
import type { PulseRow } from './use-pulse-fleet'

/**
 * Keyboard spine for a Pulse surface.
 *
 * The selection is held by ROW ID, not index: rows re-sort every tick as ages
 * change and statuses flip, and an index would silently slide the cursor onto a
 * different conversation under the user's hands.
 *
 * Empty query preselects the first row — which, because NEEDS YOU sorts oldest
 * first, is always the thing that has been waiting longest. That is what makes
 * a blind `chord, enter` land on the fire.
 */
export function usePulseKeys(rows: PulseRow[], onOpen: (row: PulseRow) => void) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const index = Math.max(
    0,
    rows.findIndex(r => r.id === activeId),
  )
  const active = rows[index] ?? rows[0] ?? null

  // Selection follows the list when the row it pointed at is filtered away.
  useEffect(() => {
    if (!rows.length) {
      if (activeId !== null) setActiveId(null)
      return
    }
    if (!activeId || !rows.some(r => r.id === activeId)) setActiveId(rows[0].id)
  }, [rows, activeId])

  const move = useCallback(
    (delta: number) => {
      if (!rows.length) return
      const next = Math.min(rows.length - 1, Math.max(0, index + delta))
      setActiveId(rows[next].id)
    },
    [rows, index],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (active) onOpen(active)
      }
    },
    [move, active, onOpen],
  )

  return { activeId: active?.id ?? null, setActiveId, handleKeyDown }
}
