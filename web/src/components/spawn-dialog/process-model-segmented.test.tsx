/**
 * ProcessModelSegmented -- the claude "Process model" picker (transport
 * selection) for the spawn dialog + launch-profile editor (transport reframe
 * Phase 5).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ProcessModelSegmented } from './process-model-segmented'

afterEach(cleanup)

describe('ProcessModelSegmented', () => {
  test('renders the three process-model tiles', () => {
    render(<ProcessModelSegmented value="claude-pty" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Interactive/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Headless/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Daemon/ })).toBeDefined()
  })

  test('marks the active transport as pressed', () => {
    render(<ProcessModelSegmented value="claude-daemon" onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Daemon/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Interactive/ }).getAttribute('aria-pressed')).toBe('false')
  })

  test('clicking a tile reports the matching transport', () => {
    const onChange = vi.fn()
    render(<ProcessModelSegmented value="claude-pty" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Daemon/ }))
    expect(onChange).toHaveBeenCalledWith('claude-daemon')
    fireEvent.click(screen.getByRole('button', { name: /Headless/ }))
    expect(onChange).toHaveBeenCalledWith('claude-headless')
  })

  test('renders the heading by default and hides it when showHeading is false', () => {
    const { rerender } = render(<ProcessModelSegmented value="claude-pty" onChange={vi.fn()} />)
    expect(screen.getByText('Process model')).toBeDefined()
    rerender(<ProcessModelSegmented value="claude-pty" onChange={vi.fn()} showHeading={false} />)
    expect(screen.queryByText('Process model')).toBeNull()
  })
})
