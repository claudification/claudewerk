/**
 * ManagerEditor + DaemonConfigSection -- daemon launch profile editing.
 *
 * Transport reframe (Phase 6): a daemon profile is `backend:'claude'` +
 * `transport:'claude-daemon'` and always NEW-mode. The injected config paths
 * ride the web-readable `settingsPath` / `mcpConfigPath` fields (never the
 * opaque transportMeta bag, which the control panel must not read).
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

/** A canonical daemon profile spawn slice. */
const daemonSpawn = (over: LaunchProfile['spawn'] = {}): LaunchProfile['spawn'] => ({
  backend: 'claude',
  transport: 'claude-daemon',
  ...over,
})

describe('DaemonConfigSection', () => {
  test('renders the two config-path fields (NEW-mode only, no mode pills)', () => {
    render(<DaemonConfigSection spawn={daemonSpawn()} onPatch={vi.fn()} />)
    expect(screen.getByText('Daemon launch')).toBeDefined()
    expect(screen.getByPlaceholderText('/abs/path/to/settings.json')).toBeDefined()
    expect(screen.getByPlaceholderText('/abs/path/to/mcp.json')).toBeDefined()
    // A daemon profile is always NEW; there are no mode pills.
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull()
  })

  test('typing a settings path patches settingsPath', () => {
    const onPatch = vi.fn()
    render(<DaemonConfigSection spawn={daemonSpawn()} onPatch={onPatch} />)
    fireEvent.change(screen.getByPlaceholderText('/abs/path/to/settings.json'), {
      target: { value: '/etc/claude/settings.json' },
    })
    expect(onPatch).toHaveBeenCalledWith({ settingsPath: '/etc/claude/settings.json' })
  })

  test('clearing a path patches the field to undefined', () => {
    const onPatch = vi.fn()
    render(<DaemonConfigSection spawn={daemonSpawn({ mcpConfigPath: '/m.json' })} onPatch={onPatch} />)
    fireEvent.change(screen.getByPlaceholderText('/abs/path/to/mcp.json'), { target: { value: '' } })
    expect(onPatch).toHaveBeenCalledWith({ mcpConfigPath: undefined })
  })

  test('shows the saved config paths', () => {
    render(
      <DaemonConfigSection
        spawn={daemonSpawn({ settingsPath: '/s.json', mcpConfigPath: '/m.json' })}
        onPatch={vi.fn()}
      />,
    )
    expect((screen.getByPlaceholderText('/abs/path/to/settings.json') as HTMLInputElement).value).toBe('/s.json')
    expect((screen.getByPlaceholderText('/abs/path/to/mcp.json') as HTMLInputElement).value).toBe('/m.json')
  })
})

describe('ManagerEditor -- daemon transport', () => {
  test('shows the Daemon launch section for a daemon profile', () => {
    render(<ManagerEditor profile={profile(daemonSpawn())} onChange={vi.fn()} />)
    expect(screen.getByText('Daemon launch')).toBeDefined()
  })

  test('hides the Daemon launch section for a claude profile', () => {
    render(<ManagerEditor profile={profile({ backend: 'claude' })} onChange={vi.fn()} />)
    expect(screen.queryByText('Daemon launch')).toBeNull()
  })

  test('daemon profile hides claude-only launch fields (effort, permissions)', () => {
    render(<ManagerEditor profile={profile(daemonSpawn())} onChange={vi.fn()} />)
    expect(screen.queryByText('Effort')).toBeNull()
    expect(screen.queryByText('Permissions')).toBeNull()
    // Model is still injected on the daemon worker.
    expect(screen.getByText('Model')).toBeDefined()
  })

  test('daemon profile keeps the system-prompt suffix editor (spike 2: --append-system-prompt works)', () => {
    render(<ManagerEditor profile={profile(daemonSpawn())} onChange={vi.fn()} />)
    expect(screen.getByText('System prompt suffix')).toBeDefined()
    expect(screen.queryByText(/cannot honor an appended system/)).toBeNull()
  })

  test('editing a daemon config path bubbles through onChange', () => {
    const onChange = vi.fn()
    render(<ManagerEditor profile={profile(daemonSpawn())} onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('/abs/path/to/settings.json'), {
      target: { value: '/abs/settings.json' },
    })
    const next = onChange.mock.calls[0]![0] as LaunchProfile
    expect(next.spawn.settingsPath).toBe('/abs/settings.json')
    expect(next.spawn.transport).toBe('claude-daemon')
  })
})

describe('ManagerEditor -- process model', () => {
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

  test('a profile carrying transport=claude-daemon is detected as daemon', () => {
    render(<ManagerEditor profile={profile(daemonSpawn())} onChange={vi.fn()} />)
    expect(screen.getByText('Daemon launch')).toBeDefined()
  })

  test('switching the process model to Daemon writes transport=claude-daemon (NOT backend:daemon)', () => {
    const next = editViaProcessModel({ backend: 'claude' }, /Daemon/)
    expect(next.spawn.backend).toBeUndefined()
    expect(next.spawn.transport).toBe('claude-daemon')
  })

  test('switching a daemon profile back to Interactive clears the daemon config', () => {
    const next = editViaProcessModel(daemonSpawn({ settingsPath: '/s.json' }), /Interactive/)
    expect(next.spawn.backend).toBeUndefined()
    expect(next.spawn.transport).toBe('claude-pty')
    expect(next.spawn.settingsPath).toBeUndefined()
  })
})
