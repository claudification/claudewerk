/**
 * Modal shell behaviour.
 *
 * The surface itself is thin -- chrome plus a pane switch -- so what is worth
 * pinning is that it stays CLOSED until the manager opens it (a modal that
 * renders itself on mount would cover the app), and that opening it lands on
 * the right pane.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { openScheduledTasksModal } from './modal-state'
import { useScheduledTasksModalStore } from './modal-state'
import { ScheduledTasksModal } from './scheduled-tasks-modal'
import { useScheduledTasksStore } from './store'

function html(): string {
  render(<ScheduledTasksModal />)
  // Radix portals the dialog body, so the whole document is the surface here.
  return document.body.innerHTML
}

beforeEach(() => {
  useModalManagerStore.setState({ modals: {} })
  useScheduledTasksStore.setState({ tasks: [], loaded: true, runs: {} })
  useScheduledTasksModalStore.setState({ projectFilter: undefined, selectedId: undefined, mode: 'browse' })
})

afterEach(cleanup)

describe('ScheduledTasksModal', () => {
  it('renders nothing until the modal manager opens it', () => {
    expect(html()).not.toContain('Scheduled Tasks')
  })

  it('shows its chrome once opened', () => {
    openScheduledTasksModal()
    expect(html()).toContain('Scheduled Tasks')
  })

  it('opens on the browse pane', () => {
    openScheduledTasksModal()
    const out = html()
    expect(out).toContain('+ New schedule')
    expect(out).not.toContain('Save schedule')
  })

  it('switching to create shows the editor instead', () => {
    openScheduledTasksModal()
    useScheduledTasksModalStore.setState({ mode: 'create' })
    const out = html()
    expect(out).toContain('Save schedule')
    expect(out).toContain('new')
  })

  it('opening from a project carries the filter through', () => {
    openScheduledTasksModal('claude:///alpha')
    expect(useScheduledTasksModalStore.getState().projectFilter).toBe('claude:///alpha')
    expect(html()).toContain('filtered:')
  })
})
