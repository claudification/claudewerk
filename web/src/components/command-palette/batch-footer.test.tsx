import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_BATCH_ACTIONS, type BatchAction } from './batch-actions'
import { BatchFooter } from './batch-footer'

afterEach(cleanup)

const broadcastAction = ALL_BATCH_ACTIONS.find(a => a.requiresInput === 'broadcast') as BatchAction
const reassignAction = ALL_BATCH_ACTIONS.find(a => a.requiresInput === 'reassign') as BatchAction
const plainAction = ALL_BATCH_ACTIONS.find(a => !a.requiresInput) as BatchAction

function renderFooter(over: Partial<Parameters<typeof BatchFooter>[0]> = {}) {
  const props = {
    action: plainAction,
    onActionChange: vi.fn(),
    selectedCount: 3,
    hiddenSelected: 0,
    canRun: true,
    broadcast: '',
    onBroadcastChange: vi.fn(),
    reassign: { project: '', sentinel: '', profile: '' },
    onReassignChange: vi.fn(),
    sentinels: [],
    onCancel: vi.fn(),
    onRun: vi.fn(),
    ...over,
  }
  return { props, ...render(<BatchFooter {...props} />) }
}

describe('BatchFooter', () => {
  it('labels the run button with the selection count', () => {
    renderFooter({ selectedCount: 12 })
    expect(screen.getByText('Run on 12 selected')).toBeDefined()
  })

  it('disables run when the caller says it cannot', () => {
    renderFooter({ canRun: false })
    expect((screen.getByText(/Run on/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows no form for an action that takes none', () => {
    renderFooter()
    expect(screen.queryByLabelText(/Broadcast message/)).toBeNull()
    expect(screen.queryByLabelText(/Target project URI/)).toBeNull()
  })

  it('shows the broadcast textarea for the broadcast action', () => {
    const { props } = renderFooter({ action: broadcastAction })
    const ta = screen.getByLabelText('Broadcast message text')
    fireEvent.change(ta, { target: { value: 'ping' } })
    expect(props.onBroadcastChange).toHaveBeenCalledWith('ping')
  })

  it('shows the reassign fields and patches only the field that changed', () => {
    const { props } = renderFooter({ action: reassignAction })
    fireEvent.change(screen.getByLabelText('Target profile'), { target: { value: 'work' } })
    expect(props.onReassignChange).toHaveBeenCalledWith({ profile: 'work' })
  })

  it('says nothing about hidden picks when there are none', () => {
    renderFooter({ hiddenSelected: 0 })
    expect(screen.queryByText(/hidden by the current filter/)).toBeNull()
  })

  it('warns when the filter is hiding part of the selection', () => {
    renderFooter({ hiddenSelected: 1 })
    expect(screen.getByText('1 selected is hidden by the current filter')).toBeDefined()
    cleanup()
    renderFooter({ hiddenSelected: 4 })
    expect(screen.getByText('4 selected are hidden by the current filter')).toBeDefined()
  })

  it('wires cancel and run', () => {
    const { props } = renderFooter()
    fireEvent.click(screen.getByText('Cancel'))
    fireEvent.click(screen.getByText(/Run on/))
    expect(props.onCancel).toHaveBeenCalled()
    expect(props.onRun).toHaveBeenCalled()
  })

  it('emits the picked action id', () => {
    const { props } = renderFooter()
    fireEvent.change(screen.getByLabelText('Batch action'), { target: { value: broadcastAction.id } })
    expect(props.onActionChange).toHaveBeenCalledWith(broadcastAction.id)
  })
})
