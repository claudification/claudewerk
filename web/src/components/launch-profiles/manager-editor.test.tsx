/**
 * ManagerEditor + DaemonConfigSection -- daemon launch profile editing.
 *
 * Phase F: the profile manager must edit daemon launch config (mode +
 * settings/mcp paths) and must NOT offer `attach` as a profile mode.
 */

import type { LaunchProfile } from '@shared/launch-profile'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DaemonConfigSection } from './editor-sections'
import { ManagerEditor } from './manager-editor'

afterEach(cleanup)

function profile(spawn: LaunchProfile['spawn']): LaunchProfile {
  return { id: 'lp_t', name: 'Test profile', spawn, createdAt: 0, updatedAt: 0 }
}

describe('DaemonConfigSection', () => {
  test('renders mode pills and the two config-path fields', () => {
    render(<DaemonConfigSection spawn={{ backend: 'daemon', daemonMode: 'new' }} onPatch={vi.fn()} />)
    expect(screen.getByText('Daemon launch')).toBeDefined()
    expect(screen.getByRole('button', { name: 'New' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDefined()
    expect(screen.getByPlaceholderText('/abs/path/to/settings.json')).toBeDefined()
    expect(screen.getByPlaceholderText('/abs/path/to/mcp.json')).toBeDefined()
  })

  test('never offers attach as a mode -- only New / Resume', () => {
    render(<DaemonConfigSection spawn={{ backend: 'daemon', daemonMode: 'new' }} onPatch={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull()
  })

  test('New is active for a fresh daemon profile (daemonMode undefined)', () => {
    render(<DaemonConfigSection spawn={{ backend: 'daemon' }} onPatch={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'New' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Resume' }).getAttribute('aria-pressed')).toBe('false')
  })

  test('clicking Resume patches daemonMode', () => {
    const onPatch = vi.fn()
    render(<DaemonConfigSection spawn={{ backend: 'daemon', daemonMode: 'new' }} onPatch={onPatch} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onPatch).toHaveBeenCalledWith({ daemonMode: 'resume' })
  })

  test('typing a settings path patches daemonSettingsPath', () => {
    const onPatch = vi.fn()
    render(<DaemonConfigSection spawn={{ backend: 'daemon', daemonMode: 'new' }} onPatch={onPatch} />)
    fireEvent.change(screen.getByPlaceholderText('/abs/path/to/settings.json'), {
      target: { value: '/etc/claude/settings.json' },
    })
    expect(onPatch).toHaveBeenCalledWith({ daemonSettingsPath: '/etc/claude/settings.json' })
  })

  test('clearing a path patches the field to undefined', () => {
    const onPatch = vi.fn()
    render(
      <DaemonConfigSection
        spawn={{ backend: 'daemon', daemonMode: 'new', daemonMcpConfigPath: '/m.json' }}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('/abs/path/to/mcp.json'), { target: { value: '' } })
    expect(onPatch).toHaveBeenCalledWith({ daemonMcpConfigPath: undefined })
  })

  test('shows the saved config paths', () => {
    render(
      <DaemonConfigSection
        spawn={{
          backend: 'daemon',
          daemonMode: 'resume',
          daemonSettingsPath: '/s.json',
          daemonMcpConfigPath: '/m.json',
        }}
        onPatch={vi.fn()}
      />,
    )
    expect((screen.getByPlaceholderText('/abs/path/to/settings.json') as HTMLInputElement).value).toBe('/s.json')
    expect((screen.getByPlaceholderText('/abs/path/to/mcp.json') as HTMLInputElement).value).toBe('/m.json')
  })
})

describe('ManagerEditor -- daemon backend', () => {
  test('shows the Daemon launch section for a daemon profile', () => {
    render(<ManagerEditor profile={profile({ backend: 'daemon', daemonMode: 'new' })} onChange={vi.fn()} />)
    expect(screen.getByText('Daemon launch')).toBeDefined()
  })

  test('hides the Daemon launch section for a claude profile', () => {
    render(<ManagerEditor profile={profile({ backend: 'claude' })} onChange={vi.fn()} />)
    expect(screen.queryByText('Daemon launch')).toBeNull()
  })

  test('daemon profile hides claude-only launch fields (effort, permissions)', () => {
    render(<ManagerEditor profile={profile({ backend: 'daemon', daemonMode: 'new' })} onChange={vi.fn()} />)
    expect(screen.queryByText('Effort')).toBeNull()
    expect(screen.queryByText('Permissions')).toBeNull()
    // Model is still injected via `claude --bg --model`.
    expect(screen.getByText('Model')).toBeDefined()
  })

  test('daemon profile keeps the system-prompt suffix editor (spike 2: --append-system-prompt works)', () => {
    render(<ManagerEditor profile={profile({ backend: 'daemon', daemonMode: 'new' })} onChange={vi.fn()} />)
    expect(screen.getByText('System prompt suffix')).toBeDefined()
    expect(screen.queryByText(/cannot honor an appended system/)).toBeNull()
  })

  test('editing the daemon mode bubbles a patched profile through onChange', () => {
    const onChange = vi.fn()
    render(<ManagerEditor profile={profile({ backend: 'daemon', daemonMode: 'new' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as LaunchProfile
    expect(next.spawn.daemonMode).toBe('resume')
    expect(next.spawn.backend).toBe('daemon')
  })

  test('editing a daemon config path bubbles through onChange', () => {
    const onChange = vi.fn()
    render(<ManagerEditor profile={profile({ backend: 'daemon', daemonMode: 'new' })} onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('/abs/path/to/settings.json'), {
      target: { value: '/abs/settings.json' },
    })
    const next = onChange.mock.calls[0]![0] as LaunchProfile
    expect(next.spawn.daemonSettingsPath).toBe('/abs/settings.json')
  })
})

describe('ManagerEditor -- process model (transport reframe Phase 5)', () => {
  // Render an editor, click a Process model tile, return the patched profile.
  function editViaProcessModel(spawn: LaunchProfile['spawn'], tile: RegExp): LaunchProfile {
    const onChange = vi.fn()
    render(<ManagerEditor profile={profile(spawn)} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: tile }))
    return onChange.mock.calls[0]![0] as LaunchProfile
  }

  test('renders the Process model picker for a claude profile', () => {
    render(<ManagerEditor profile={profile({ backend: 'claude' })} onChange={vi.fn()} />)
    expect(screen.getByText('Process model')).toBeDefined()
  })

  test('a profile carrying only transport=claude-daemon is detected as daemon', () => {
    render(<ManagerEditor profile={profile({ transport: 'claude-daemon', daemonMode: 'new' })} onChange={vi.fn()} />)
    expect(screen.getByText('Daemon launch')).toBeDefined()
  })

  test('switching the process model to Daemon patches backend + transport + seeds daemonMode', () => {
    const next = editViaProcessModel({ backend: 'claude' }, /Daemon/)
    expect(next.spawn.backend).toBe('daemon')
    expect(next.spawn.transport).toBe('claude-daemon')
    expect(next.spawn.daemonMode).toBe('new')
  })

  test('switching a daemon profile back to Interactive clears the daemon config', () => {
    const next = editViaProcessModel(
      { backend: 'daemon', daemonMode: 'resume', daemonSettingsPath: '/s.json' },
      /Interactive/,
    )
    expect(next.spawn.backend).toBeUndefined()
    expect(next.spawn.transport).toBe('claude-pty')
    expect(next.spawn.daemonMode).toBeUndefined()
    expect(next.spawn.daemonSettingsPath).toBeUndefined()
  })
})
