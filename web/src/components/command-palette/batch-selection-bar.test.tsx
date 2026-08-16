import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BatchSelectionBar } from './batch-selection-bar'

afterEach(cleanup)

function renderBar(over: Partial<Parameters<typeof BatchSelectionBar>[0]> = {}) {
  const props = {
    matches: 10,
    visibleSelected: 0,
    cap: 50,
    groupByProject: true,
    onGroupByProject: vi.fn(),
    selectedOnly: false,
    onSelectedOnly: vi.fn(),
    showSelectedOnly: false,
    onSelectVisible: vi.fn(),
    onInvert: vi.fn(),
    onSelectAll: vi.fn(),
    onClear: vi.fn(),
    ...over,
  }
  return { props, ...render(<BatchSelectionBar {...props} />) }
}

describe('BatchSelectionBar', () => {
  it('shows the match count and hides the selected tally at zero', () => {
    renderBar()
    expect(screen.getByText('10 matches')).toBeDefined()
  })

  it('appends the visible-selected tally once something is picked', () => {
    renderBar({ visibleSelected: 3 })
    expect(screen.getByText(/10 matches · 3 sel/)).toBeDefined()
  })

  it('only offers "selected only" once something is selected', () => {
    const { unmount } = renderBar()
    expect(screen.queryByText('selected only')).toBeNull()
    unmount()
    renderBar({ showSelectedOnly: true })
    expect(screen.getByText('selected only')).toBeDefined()
  })

  it('hides the select-all-past-the-cap control under the cap', () => {
    renderBar({ matches: 10, cap: 50 })
    expect(screen.queryByText(/Select all/)).toBeNull()
  })

  it('keeps the confirm folded away until asked for', () => {
    renderBar({ matches: 77, cap: 50 })
    expect(screen.queryByPlaceholderText(/type "select 77"/)).toBeNull()
    fireEvent.click(screen.getByText(/Select all 77/))
    expect(screen.getByPlaceholderText('type "select 77"')).toBeDefined()
  })

  it('runs select-all only on the exact phrase', () => {
    const { props } = renderBar({ matches: 77, cap: 50 })
    fireEvent.click(screen.getByText(/Select all 77/))
    const confirmBtn = screen.getByText('Confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('type "select 77"'), { target: { value: 'select 7' } })
    expect((screen.getByText('Confirm') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('type "select 77"'), { target: { value: 'select 77' } })
    fireEvent.click(screen.getByText('Confirm'))
    expect(props.onSelectAll).toHaveBeenCalled()
  })

  it('folds the confirm away when the match count moves under it', () => {
    const { rerender, props } = renderBar({ matches: 77, cap: 50 })
    fireEvent.click(screen.getByText(/Select all 77/))
    fireEvent.change(screen.getByPlaceholderText('type "select 77"'), { target: { value: 'select 77' } })
    // A phrase typed against 77 rows must not stay armed for a different result set.
    rerender(<BatchSelectionBar {...props} matches={60} />)
    expect(screen.queryByText('Confirm')).toBeNull()
    expect(screen.getByText(/Select all 60/)).toBeDefined()
  })

  it('wires the plain bulk buttons', () => {
    const { props } = renderBar()
    fireEvent.click(screen.getByText(/Select visible/))
    fireEvent.click(screen.getByText('Invert'))
    fireEvent.click(screen.getByText('Clear'))
    expect(props.onSelectVisible).toHaveBeenCalled()
    expect(props.onInvert).toHaveBeenCalled()
    expect(props.onClear).toHaveBeenCalled()
  })

  it('toggles group-by-project', () => {
    const { props } = renderBar()
    fireEvent.click(screen.getByLabelText('group by project'))
    expect(props.onGroupByProject).toHaveBeenCalledWith(false)
  })
})
