/**
 * DaemonModePanel component tests -- the NEW / RESUME config editor.
 * Verifies per-mode rendering and that field edits flow back through onChange.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { blankDaemonForm, type DaemonModeFormValue } from './daemon-launch'
import { DaemonModePanel } from './daemon-mode-panel'

afterEach(cleanup)

/** Stateful harness so edits round-trip through a real value, like the dialog. */
function Harness({
  mode,
  tab = 'basic',
  onChangeSpy,
}: {
  mode: 'new' | 'resume'
  tab?: 'basic' | 'advanced'
  onChangeSpy?: (p: Partial<DaemonModeFormValue>) => void
}) {
  const [value, setValue] = useState<DaemonModeFormValue>(blankDaemonForm)
  return (
    <DaemonModePanel
      mode={mode}
      tab={tab}
      value={value}
      onChange={patch => {
        onChangeSpy?.(patch)
        setValue(prev => ({ ...prev, ...patch }))
      }}
    />
  )
}

describe('DaemonModePanel -- NEW', () => {
  test('renders an optional prompt field (promptless NEW) and no resume field', () => {
    render(<Harness mode="new" />)
    expect(screen.getByText('(optional)')).toBeDefined()
    expect(screen.getByPlaceholderText('First turn for the new daemon worker (optional)...')).toBeDefined()
    expect(screen.queryByPlaceholderText('daemon session id to fork from')).toBeNull()
  })

  test('hides the advanced fields on the Basic tab', () => {
    render(<Harness mode="new" tab="basic" />)
    expect(screen.queryByPlaceholderText('/abs/path/to/settings.json')).toBeNull()
    expect(screen.queryByPlaceholderText('/abs/path/to/mcp.json')).toBeNull()
    expect(screen.queryByPlaceholderText('branch name')).toBeNull()
  })

  test('renders the settings, mcp-config and worktree fields on the Advanced tab', () => {
    render(<Harness mode="new" tab="advanced" />)
    expect(screen.getByPlaceholderText('/abs/path/to/settings.json')).toBeDefined()
    expect(screen.getByPlaceholderText('/abs/path/to/mcp.json')).toBeDefined()
    expect(screen.getByPlaceholderText('branch name')).toBeDefined()
  })

  test('typing the prompt patches onChange', () => {
    const spy = vi.fn()
    render(<Harness mode="new" onChangeSpy={spy} />)
    const textarea = screen.getByPlaceholderText('First turn for the new daemon worker (optional)...')
    fireEvent.change(textarea, { target: { value: 'build the feature' } })
    expect(spy).toHaveBeenCalledWith({ prompt: 'build the feature' })
  })

  test('flags a non-absolute settings path inline', () => {
    render(<Harness mode="new" tab="advanced" />)
    const settings = screen.getByPlaceholderText('/abs/path/to/settings.json')
    fireEvent.change(settings, { target: { value: 'relative.json' } })
    expect(screen.getByText('Must be an absolute path (start with /)')).toBeDefined()
  })

  test('an absolute settings path shows no error', () => {
    render(<Harness mode="new" tab="advanced" />)
    const settings = screen.getByPlaceholderText('/abs/path/to/settings.json')
    fireEvent.change(settings, { target: { value: '/etc/claude/settings.json' } })
    expect(screen.queryByText('Must be an absolute path (start with /)')).toBeNull()
  })
})

describe('DaemonModePanel -- RESUME', () => {
  test('renders the resume session id field and an optional prompt', () => {
    render(<Harness mode="resume" />)
    expect(screen.getByPlaceholderText('daemon session id to fork from')).toBeDefined()
    expect(screen.getByText('(optional)')).toBeDefined()
    expect(screen.getByPlaceholderText('Optional first turn after resume...')).toBeDefined()
  })

  test('typing the resume session id patches onChange', () => {
    const spy = vi.fn()
    render(<Harness mode="resume" onChangeSpy={spy} />)
    const input = screen.getByPlaceholderText('daemon session id to fork from')
    fireEvent.change(input, { target: { value: 'ccs_prior_session' } })
    expect(spy).toHaveBeenCalledWith({ resumeSessionId: 'ccs_prior_session' })
  })
})
