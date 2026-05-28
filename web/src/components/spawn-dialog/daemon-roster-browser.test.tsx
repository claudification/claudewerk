/**
 * DaemonRosterBrowser component tests -- the ATTACH-mode worker picker.
 * Seeds the conversations store's `daemonRosters` slice (the same path the
 * `daemon_roster` WS handler writes) and verifies rendering + selection.
 */

import type { DaemonRosterForward, DaemonRosterJob } from '@shared/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { DaemonRosterBrowser } from './daemon-roster-browser'

afterEach(() => {
  cleanup()
  useConversationsStore.setState({ daemonRosters: {} })
})

function job(overrides: Partial<DaemonRosterJob> = {}): DaemonRosterJob {
  return {
    conversationId: 'conv_a',
    short: 'aeb185f9',
    cwd: '/Users/jonas/projects/x',
    state: 'working',
    name: 'fix the bug',
    cliVersion: '2.1.144',
    ...overrides,
  }
}

function seedRoster(overrides: Partial<DaemonRosterForward> = {}): void {
  const forward: DaemonRosterForward = {
    type: 'daemon_roster',
    sentinelId: 'snt_1',
    sentinelAlias: 'workstation',
    daemonPresent: true,
    daemonProto: 1,
    jobs: [job()],
    observedAt: Date.now(),
    ...overrides,
  }
  useConversationsStore.setState({ daemonRosters: { [forward.sentinelId ?? 'default']: forward } })
}

describe('DaemonRosterBrowser', () => {
  test('shows a loading state before any roster arrives', () => {
    useConversationsStore.setState({ daemonRosters: {} })
    render(<DaemonRosterBrowser selectedShort={undefined} onSelect={vi.fn()} />)
    expect(screen.getByText('Loading daemon roster…')).toBeDefined()
  })

  test('shows a no-daemon hint when the sentinel reports daemonPresent false', () => {
    seedRoster({ daemonPresent: false, jobs: [] })
    render(<DaemonRosterBrowser selectedShort={undefined} onSelect={vi.fn()} />)
    expect(screen.getByText(/No/)).toBeDefined()
    expect(screen.getByText(/claude daemon/)).toBeDefined()
  })

  test('shows an empty message when the daemon is up but has no live workers', () => {
    seedRoster({ jobs: [] })
    render(<DaemonRosterBrowser selectedShort={undefined} onSelect={vi.fn()} />)
    expect(screen.getByText('No live daemon workers to attach to.')).toBeDefined()
  })

  test('renders a row per live worker with name, state and cwd', () => {
    seedRoster({ jobs: [job()] })
    render(<DaemonRosterBrowser selectedShort={undefined} onSelect={vi.fn()} />)
    expect(screen.getByText('fix the bug')).toBeDefined()
    expect(screen.getByText('working')).toBeDefined()
    expect(screen.getByText('~/projects/x')).toBeDefined()
    expect(screen.getByText('cli 2.1.144')).toBeDefined()
  })

  test('filters out terminal-state jobs (done/failed/stopped/crashed)', () => {
    seedRoster({
      jobs: [
        job({ short: 'aaaaaaaa', name: 'live one', state: 'working' }),
        job({ short: 'bbbbbbbb', name: 'dead one', state: 'done' }),
      ],
    })
    render(<DaemonRosterBrowser selectedShort={undefined} onSelect={vi.fn()} />)
    expect(screen.getByText('live one')).toBeDefined()
    expect(screen.queryByText('dead one')).toBeNull()
  })

  test('clicking a worker fires onSelect with the tagged roster entry', () => {
    const onSelect = vi.fn()
    seedRoster({ jobs: [job({ short: 'aeb185f9', name: 'fix the bug' })] })
    render(<DaemonRosterBrowser selectedShort={undefined} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('fix the bug'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    const entry = onSelect.mock.calls[0]![0]
    expect(entry.short).toBe('aeb185f9')
    expect(entry.sentinelAlias).toBe('workstation')
    expect(entry.sentinelId).toBe('snt_1')
  })

  test('clicking the already-selected worker clears the selection', () => {
    const onSelect = vi.fn()
    seedRoster({ jobs: [job({ short: 'aeb185f9', name: 'fix the bug' })] })
    render(<DaemonRosterBrowser selectedShort="aeb185f9" onSelect={onSelect} />)
    fireEvent.click(screen.getByText('fix the bug'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  test('falls back to the short id when a worker has no name', () => {
    seedRoster({ jobs: [job({ short: 'deadbeef', name: undefined })] })
    render(<DaemonRosterBrowser selectedShort={undefined} onSelect={vi.fn()} />)
    expect(screen.getByText('deadbeef')).toBeDefined()
  })
})
