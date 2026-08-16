import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/types'
import type { ConvRow, FlatRow } from './batch-grouping'
import { useBatchSelection } from './use-batch-selection'

const A = 'claude://default/a'
const B = 'claude://default/b'

const conv = (id: string, project: string): Conversation => ({ id, project }) as Conversation

/** Two projects: A has a1/a2/a3, B has b1. Group headers included. */
const ROWS: FlatRow[] = [
  { kind: 'group', project: A, label: 'A', count: 3 },
  { kind: 'conv', project: A, conv: conv('a1', A) },
  { kind: 'conv', project: A, conv: conv('a2', A) },
  { kind: 'conv', project: A, conv: conv('a3', A) },
  { kind: 'group', project: B, label: 'B', count: 1 },
  { kind: 'conv', project: B, conv: conv('b1', B) },
]
const CONV_ROWS = ROWS.filter((r): r is ConvRow => r.kind === 'conv')

function setup(selectedIds: string[] = [], cap = 50) {
  const selectBatch = vi.fn()
  const toggleOne = vi.fn()
  const { result } = renderHook(() =>
    useBatchSelection({
      flatRows: ROWS,
      convRows: CONV_ROWS,
      selected: new Set(selectedIds),
      selectBatch,
      toggleOne,
      cap,
    }),
  )
  return { result, selectBatch, toggleOne }
}

describe('useBatchSelection -- toggleAt', () => {
  it('delegates a plain click to the single-toggle action', () => {
    const { result, toggleOne, selectBatch } = setup()
    act(() => result.current.toggleAt(1, false))
    expect(toggleOne).toHaveBeenCalledWith('a1')
    expect(selectBatch).not.toHaveBeenCalled()
  })

  it('ignores a group header index', () => {
    const { result, toggleOne, selectBatch } = setup()
    act(() => result.current.toggleAt(0, false))
    expect(toggleOne).not.toHaveBeenCalled()
    expect(selectBatch).not.toHaveBeenCalled()
  })

  it('shift-selects the range between the last click and this one, skipping headers', () => {
    const { result, selectBatch } = setup()
    act(() => result.current.toggleAt(1, false))
    act(() => result.current.toggleAt(5, true))
    expect(selectBatch.mock.calls[0][0].toSorted()).toEqual(['a1', 'a2', 'a3', 'b1'])
  })

  it('shift over an already-full range deselects it', () => {
    const { result, selectBatch } = setup(['a1', 'a2', 'a3'])
    act(() => result.current.toggleAt(1, false))
    act(() => result.current.toggleAt(3, true))
    expect(selectBatch).toHaveBeenCalledWith([])
  })
})

describe('useBatchSelection -- groups', () => {
  it('selects every row of a project', () => {
    const { result, selectBatch } = setup()
    act(() => result.current.toggleGroup(A))
    expect(selectBatch.mock.calls[0][0].toSorted()).toEqual(['a1', 'a2', 'a3'])
  })

  it('clears a fully-selected project without touching the others', () => {
    const { result, selectBatch } = setup(['a1', 'a2', 'a3', 'b1'])
    act(() => result.current.toggleGroup(A))
    expect(selectBatch).toHaveBeenCalledWith(['b1'])
  })

  it('reports checked / indeterminate per project', () => {
    const { result } = setup(['a1'])
    expect(result.current.groupState(A)).toEqual({ checked: false, indeterminate: true })
    expect(result.current.groupState(B)).toEqual({ checked: false, indeterminate: false })
  })

  it('reports checked when the whole project is selected', () => {
    const { result } = setup(['a1', 'a2', 'a3'])
    expect(result.current.groupState(A)).toEqual({ checked: true, indeterminate: false })
  })
})

describe('useBatchSelection -- bulk', () => {
  it('selectVisible stops at the cap and keeps prior picks', () => {
    const { result, selectBatch } = setup(['zz'], 2)
    act(() => result.current.selectVisible())
    expect(selectBatch.mock.calls[0][0].toSorted()).toEqual(['a1', 'a2', 'zz'])
  })

  it('selectAll takes every visible row, ignoring the cap', () => {
    const { result, selectBatch } = setup([], 2)
    act(() => result.current.selectAll())
    expect(selectBatch).toHaveBeenCalledWith(['a1', 'a2', 'a3', 'b1'])
  })

  it('invert flips the visible rows but preserves selections hidden by the filter', () => {
    const { result, selectBatch } = setup(['a1', 'hidden-one'])
    act(() => result.current.invert())
    expect(selectBatch.mock.calls[0][0].toSorted()).toEqual(['a2', 'a3', 'b1', 'hidden-one'])
  })

  it('isSelected reads the current set', () => {
    const { result } = setup(['a2'])
    expect(result.current.isSelected('a2')).toBe(true)
    expect(result.current.isSelected('a1')).toBe(false)
  })
})
