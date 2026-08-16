/**
 * Selection mechanics for batch mode: single toggle, shift-range, per-project
 * group toggle, select-visible/all, invert. Pulled out of the modal so the
 * component is wiring and these rules are testable on their own.
 */

import { useCallback, useMemo, useRef } from 'react'
import type { ConvRow, FlatRow } from './batch-grouping'

export interface BatchSelection {
  isSelected: (id: string) => boolean
  toggleAt: (idx: number, shift: boolean) => void
  toggleGroup: (project: string) => void
  selectVisible: () => void
  selectAll: () => void
  invert: () => void
  groupState: (project: string) => { checked: boolean; indeterminate: boolean }
}

export function useBatchSelection({
  flatRows,
  convRows,
  selected,
  selectBatch,
  toggleOne,
  cap,
}: {
  flatRows: FlatRow[]
  convRows: ConvRow[]
  selected: Set<string>
  selectBatch: (ids: string[]) => void
  toggleOne: (id: string) => void
  cap: number
}): BatchSelection {
  const lastClickedIndexRef = useRef<number | null>(null)

  /** project -> visible conv ids, for the group-header checkbox. */
  const groupConvIds = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const r of convRows) {
      const arr = m.get(r.project)
      if (arr) arr.push(r.conv.id)
      else m.set(r.project, [r.conv.id])
    }
    return m
  }, [convRows])

  const isSelected = useCallback((id: string) => selected.has(id), [selected])

  const toggleAt = useCallback(
    (idx: number, shift: boolean) => {
      const row = flatRows[idx]
      if (row?.kind !== 'conv') return
      if (shift && lastClickedIndexRef.current !== null) {
        const a = Math.min(lastClickedIndexRef.current, idx)
        const b = Math.max(lastClickedIndexRef.current, idx)
        const range = flatRows.slice(a, b + 1).filter((r): r is ConvRow => r.kind === 'conv')
        const anyUnselected = range.some(r => !selected.has(r.conv.id))
        const next = new Set(selected)
        for (const r of range) {
          if (anyUnselected) next.add(r.conv.id)
          else next.delete(r.conv.id)
        }
        selectBatch(Array.from(next))
      } else {
        toggleOne(row.conv.id)
      }
      lastClickedIndexRef.current = idx
    },
    [flatRows, selected, selectBatch, toggleOne],
  )

  // All selected -> clear the project; otherwise select every visible member.
  const toggleGroup = useCallback(
    (project: string) => {
      const ids = groupConvIds.get(project) ?? []
      // Empty ids never reach here (headers only render for non-empty projects);
      // a vacuous `every` -> true would no-op the loop regardless.
      const allSelected = ids.every(id => selected.has(id))
      const next = new Set(selected)
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      selectBatch(Array.from(next))
    },
    [groupConvIds, selected, selectBatch],
  )

  const selectVisible = useCallback(() => {
    const next = new Set(selected)
    for (const r of convRows.slice(0, cap)) next.add(r.conv.id)
    selectBatch(Array.from(next))
  }, [convRows, selected, selectBatch, cap])

  const selectAll = useCallback(() => {
    selectBatch(convRows.map(r => r.conv.id))
  }, [convRows, selectBatch])

  const invert = useCallback(() => {
    const next = new Set<string>()
    for (const r of convRows) {
      if (!selected.has(r.conv.id)) next.add(r.conv.id)
    }
    // Preserve any selections that are no longer visible (filtered out).
    const visible = new Set(convRows.map(r => r.conv.id))
    for (const id of selected) {
      if (!visible.has(id)) next.add(id)
    }
    selectBatch(Array.from(next))
  }, [convRows, selected, selectBatch])

  const groupState = useCallback(
    (project: string) => {
      const ids = groupConvIds.get(project) ?? []
      const sel = ids.filter(id => selected.has(id)).length
      return { checked: ids.length > 0 && sel === ids.length, indeterminate: sel > 0 && sel < ids.length }
    },
    [groupConvIds, selected],
  )

  return { isSelected, toggleAt, toggleGroup, selectVisible, selectAll, invert, groupState }
}
