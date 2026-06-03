/**
 * Tests for the host-shell store + data-handler registry (use-shells.ts).
 *
 * Covers roster mutation (snapshot/add/remove), the remove-cleans-everything
 * invariant (roster + activity + subscribed dropped together), subscription
 * flags, and the latency-critical data-handler registry that bypasses zustand.
 */
import type { ShellRosterEntry } from '@shared/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchShellData, setShellDataHandler, useShellsStore } from './use-shells'

function entry(overrides: Partial<ShellRosterEntry> = {}): ShellRosterEntry {
  return {
    shellId: 'sh_a',
    projectUri: 'claude://mac/Users/j/proj',
    sentinelId: 'snt_mac',
    path: '/Users/j/proj',
    title: 'proj',
    status: 'live',
    createdBy: 'jonas',
    createdAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  useShellsStore.getState().reset()
})

describe('roster', () => {
  it('setRoster replaces the whole snapshot keyed by shellId', () => {
    const s = useShellsStore.getState()
    s.setRoster([entry({ shellId: 'sh_a' }), entry({ shellId: 'sh_b' })])
    const roster = useShellsStore.getState().roster
    expect(Object.keys(roster).sort()).toEqual(['sh_a', 'sh_b'])
    // A second snapshot fully replaces (drops sh_b).
    useShellsStore.getState().setRoster([entry({ shellId: 'sh_a' })])
    expect(Object.keys(useShellsStore.getState().roster)).toEqual(['sh_a'])
  })

  it('addShell inserts without disturbing existing entries', () => {
    const s = useShellsStore.getState()
    s.addShell(entry({ shellId: 'sh_a' }))
    s.addShell(entry({ shellId: 'sh_b', title: 'other' }))
    expect(useShellsStore.getState().roster.sh_b.title).toBe('other')
    expect(useShellsStore.getState().roster.sh_a).toBeDefined()
  })

  it('removeShell drops roster + activity + subscribed together', () => {
    const s = useShellsStore.getState()
    s.addShell(entry({ shellId: 'sh_a' }))
    s.markActivity('sh_a', 5)
    s.markSubscribed('sh_a')
    s.removeShell('sh_a')
    const st = useShellsStore.getState()
    expect(st.roster.sh_a).toBeUndefined()
    expect(st.activity.sh_a).toBeUndefined()
    expect(st.subscribed.sh_a).toBeUndefined()
  })

  it('removeShell on an unknown id is a no-op (stable reference)', () => {
    const before = useShellsStore.getState().roster
    useShellsStore.getState().removeShell('nope')
    expect(useShellsStore.getState().roster).toBe(before)
  })
})

describe('activity + subscription', () => {
  it('markActivity records the latest timestamp', () => {
    useShellsStore.getState().markActivity('sh_a', 42)
    expect(useShellsStore.getState().activity.sh_a).toBe(42)
    useShellsStore.getState().markActivity('sh_a', 99)
    expect(useShellsStore.getState().activity.sh_a).toBe(99)
  })

  it('subscribe / unsubscribe toggles the flag', () => {
    const s = useShellsStore.getState()
    s.markSubscribed('sh_a')
    expect(useShellsStore.getState().subscribed.sh_a).toBe(true)
    s.markUnsubscribed('sh_a')
    expect(useShellsStore.getState().subscribed.sh_a).toBeUndefined()
  })

  it('markUnsubscribed on an unsubscribed shell is a no-op', () => {
    const before = useShellsStore.getState().subscribed
    useShellsStore.getState().markUnsubscribed('sh_a')
    expect(useShellsStore.getState().subscribed).toBe(before)
  })
})

describe('data-handler registry', () => {
  afterEach(() => {
    setShellDataHandler('sh_a', null)
    setShellDataHandler('sh_b', null)
  })

  it('routes a message only to the matching shell handler', () => {
    const a = vi.fn()
    const b = vi.fn()
    setShellDataHandler('sh_a', a)
    setShellDataHandler('sh_b', b)
    dispatchShellData({ type: 'shell_data', shellId: 'sh_a', data: 'x' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('dispatch to an unregistered shell is a silent no-op', () => {
    expect(() => dispatchShellData({ type: 'shell_data', shellId: 'ghost', data: 'x' })).not.toThrow()
  })

  it('unregister stops delivery', () => {
    const a = vi.fn()
    setShellDataHandler('sh_a', a)
    setShellDataHandler('sh_a', null)
    dispatchShellData({ type: 'shell_replay', shellId: 'sh_a', data: '', done: true })
    expect(a).not.toHaveBeenCalled()
  })
})
