import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ProjectSettings } from '@/lib/types'
import type { ColumnSpec } from './batch-cells'
import type { FlatRow } from './batch-grouping'
import { BatchTable } from './batch-table'

afterEach(cleanup)

const TEMP = 'claude://default/Users/jonas/temp'
const SETTINGS: Record<string, ProjectSettings> = { [TEMP]: { label: 'Scratch/Temp' } as ProjectSettings }

const conv = (id: string, over: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    project: TEMP,
    status: 'idle',
    title: `conv ${id}`,
    lastActivity: Date.now() - 3_600_000,
    ...over,
  }) as Conversation

const ROWS: FlatRow[] = [
  { kind: 'group', project: TEMP, label: 'Scratch/Temp', count: 2 },
  { kind: 'conv', project: TEMP, conv: conv('a') },
  { kind: 'conv', project: TEMP, conv: conv('b') },
]

const ALL_COLS: ColumnSpec = { project: true, host: true, recap: true }

function renderTable(rows: FlatRow[], cols: ColumnSpec) {
  return render(
    <BatchTable
      rows={rows}
      cols={cols}
      projectSettings={SETTINGS}
      focusedIndex={-1}
      isSelected={() => false}
      groupState={() => ({ checked: false, indeterminate: false })}
      onToggleGroup={vi.fn()}
      onActivate={vi.fn()}
      onFocusRow={vi.fn()}
    />,
  )
}

describe('BatchTable', () => {
  it('spans the group header across every rendered column', () => {
    const { container } = renderTable(ROWS, ALL_COLS)
    const headerCells = container.querySelectorAll('thead th')
    const groupCell = container.querySelector('tbody td[colspan]') as HTMLTableCellElement
    // REGRESSION: the colSpan was hardcoded one short, so the group band stopped
    // before the right edge of the table.
    expect(groupCell.colSpan).toBe(headerCells.length)
  })

  it('spans the empty-state row across every rendered column', () => {
    const { container } = renderTable([], { project: false, host: false, recap: false })
    const headerCells = container.querySelectorAll('thead th')
    const emptyCell = container.querySelector('tbody td[colspan]') as HTMLTableCellElement
    expect(screen.getByText('No conversations match')).toBeDefined()
    expect(emptyCell.colSpan).toBe(headerCells.length)
  })

  it('declares a width for every column so nothing reflows per row', () => {
    const { container } = renderTable(ROWS, ALL_COLS)
    expect(container.querySelectorAll('colgroup col')).toHaveLength(container.querySelectorAll('thead th').length)
  })

  it('renders the age compactly on one line', () => {
    const { container } = renderTable(ROWS, ALL_COLS)
    const last = container.querySelectorAll('tbody tr:last-child td')
    const cell = last[last.length - 1] as HTMLElement
    // "27h 2m ago" used to wrap to two lines and double the row height.
    expect(cell.textContent).toBe('1h')
    expect(cell.className).toContain('whitespace-nowrap')
  })

  it('drops the optional columns when told to', () => {
    const { container } = renderTable(ROWS, { project: false, host: false, recap: false })
    const headers = Array.from(container.querySelectorAll('thead th')).map(th => th.textContent?.trim())
    expect(headers).toEqual(['Selection', 'title', 'status', 'last'])
  })
})
