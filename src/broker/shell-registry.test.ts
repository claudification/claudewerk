/**
 * Broker host-shell registry tests (phase 3).
 *
 * Pins the roster + subscription + min-size + data-socket-pairing policy that
 * `handlers/shell.ts` relies on. Pure data-structure tests -- the ws values are
 * opaque identity keys, no live socket needed.
 */

import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { ShellRosterEntry } from '../shared/protocol'
import type { UserGrant } from './permissions'
import { BrokerShellRegistry, buildRosterSnapshot, filterRosterForGrants } from './shell-registry'

/** A distinct opaque socket identity. */
function sock(): ServerWebSocket<unknown> {
  return {} as ServerWebSocket<unknown>
}

function entry(overrides: Partial<ShellRosterEntry> = {}): ShellRosterEntry {
  return {
    shellId: 'sh_1',
    projectUri: 'claude://default/Users/jonas/projects/x',
    sentinelId: 'snt_a',
    path: '/Users/jonas/projects/x',
    title: 'x',
    status: 'live',
    createdBy: 'jonas',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('BrokerShellRegistry roster', () => {
  it('adds optimistically and rejects a duplicate shellId', () => {
    const r = new BrokerShellRegistry()
    expect(r.add(entry())).toBe(true)
    expect(r.add(entry())).toBe(false)
    expect(r.count).toBe(1)
    expect(r.has('sh_1')).toBe(true)
  })

  it('lists every live shell and removes by id', () => {
    const r = new BrokerShellRegistry()
    r.add(entry({ shellId: 'a' }))
    r.add(entry({ shellId: 'b' }))
    expect(
      r
        .list()
        .map(e => e.shellId)
        .sort(),
    ).toEqual(['a', 'b'])
    const removed = r.remove('a')
    expect(removed?.entry.shellId).toBe('a')
    expect(r.has('a')).toBe(false)
    expect(r.remove('missing')).toBeUndefined()
  })

  it('removes every shell owned by a sentinel (disconnect cleanup)', () => {
    const r = new BrokerShellRegistry()
    r.add(entry({ shellId: 'a', sentinelId: 'snt_a' }))
    r.add(entry({ shellId: 'b', sentinelId: 'snt_a' }))
    r.add(entry({ shellId: 'c', sentinelId: 'snt_b' }))
    const removed = r.removeBySentinel('snt_a')
    expect(removed.map(s => s.entry.shellId).sort()).toEqual(['a', 'b'])
    expect(r.has('c')).toBe(true)
    expect(r.count).toBe(1)
  })
})

describe('BrokerShellRegistry subscription + min-size', () => {
  it('attaches on the first viewer with that viewer’s size', () => {
    const r = new BrokerShellRegistry()
    r.add(entry())
    const a = r.subscribe('sh_1', sock(), 120, 40)
    expect(a).toEqual({ kind: 'attach', cols: 120, rows: 40 })
  })

  it('shrinks the PTY to the min across viewers (tmux policy)', () => {
    const r = new BrokerShellRegistry()
    r.add(entry())
    r.subscribe('sh_1', sock(), 120, 40)
    const second = r.subscribe('sh_1', sock(), 80, 24)
    expect(second).toEqual({ kind: 'resize', cols: 80, rows: 24 })
  })

  it('is a noop when a new viewer does not shrink the min', () => {
    const r = new BrokerShellRegistry()
    r.add(entry())
    r.subscribe('sh_1', sock(), 80, 24)
    const bigger = r.subscribe('sh_1', sock(), 200, 60)
    expect(bigger).toEqual({ kind: 'noop' })
  })

  it('detaches when the last viewer leaves and resizes when the min grows back', () => {
    const r = new BrokerShellRegistry()
    r.add(entry())
    const small = sock()
    const big = sock()
    r.subscribe('sh_1', big, 200, 60)
    r.subscribe('sh_1', small, 80, 24) // min is now 80x24
    const up = r.unsubscribe('sh_1', small) // small leaves -> min grows to 200x60
    expect(up).toEqual({ kind: 'resize', cols: 200, rows: 60 })
    const gone = r.unsubscribe('sh_1', big) // last viewer
    expect(gone).toEqual({ kind: 'detach' })
  })

  it('ignores resize / unsubscribe from a non-viewer', () => {
    const r = new BrokerShellRegistry()
    r.add(entry())
    expect(r.resize('sh_1', sock(), 80, 24)).toBeNull()
    expect(r.unsubscribe('sh_1', sock())).toBeNull()
  })

  it('returns null for an unknown shell', () => {
    const r = new BrokerShellRegistry()
    expect(r.subscribe('nope', sock(), 80, 24)).toBeNull()
  })

  it('resizes the PTY when a subscriber’s own viewport shrinks the min', () => {
    const r = new BrokerShellRegistry()
    r.add(entry())
    const ws = sock()
    r.subscribe('sh_1', ws, 120, 40)
    expect(r.resize('sh_1', ws, 90, 30)).toEqual({ kind: 'resize', cols: 90, rows: 30 })
  })

  it('drops a disconnected socket from every shell it watched', () => {
    const r = new BrokerShellRegistry()
    r.add(entry({ shellId: 'a', sentinelId: 'snt_a' }))
    r.add(entry({ shellId: 'b', sentinelId: 'snt_a' }))
    const ws = sock()
    r.subscribe('a', ws, 80, 24)
    r.subscribe('b', ws, 80, 24)
    const dropped = r.dropViewerSocket(ws)
    expect(dropped.map(d => d.shellId).sort()).toEqual(['a', 'b'])
    expect(dropped.every(d => d.action.kind === 'detach')).toBe(true)
  })
})

describe('BrokerShellRegistry data-socket pairing', () => {
  it('routes a shell to its sentinel’s data socket by machineId', () => {
    const r = new BrokerShellRegistry()
    r.add(entry({ shellId: 'a' }), { machineId: 'machine-1' })
    const ds = sock()
    r.setDataSocket('machine-1', ds)
    expect(r.dataSocketFor('a')).toBe(ds)
  })

  it('forgets a data socket on disconnect and re-attaches live shells on repair', () => {
    const r = new BrokerShellRegistry()
    r.add(entry({ shellId: 'a' }), { machineId: 'm' })
    r.subscribe('a', sock(), 100, 30)
    const ds = sock()
    r.setDataSocket('m', ds)
    expect(r.removeDataSocket(ds)).toBe('m')
    expect(r.dataSocketFor('a')).toBeUndefined()
    // On repair, the shell still has a viewer -> must be re-attached.
    const reattach = r.shellsNeedingReattach('m')
    expect(reattach).toEqual([{ shellId: 'a', cols: 100, rows: 30 }])
  })

  it('does not re-attach a shell with no viewers', () => {
    const r = new BrokerShellRegistry()
    r.add(entry({ shellId: 'a' }), { machineId: 'm' })
    expect(r.shellsNeedingReattach('m')).toEqual([])
  })
})

describe('roster permission filtering', () => {
  const rosterEntries = [
    entry({ shellId: 'x', projectUri: 'claude://default/Users/jonas/projects/x' }),
    entry({ shellId: 'y', projectUri: 'claude://default/Users/jonas/projects/y' }),
  ]

  it('passes everything through for an infrastructure connection (no grants)', () => {
    expect(filterRosterForGrants(rosterEntries, undefined)).toHaveLength(2)
  })

  it('keeps only shells whose URI the grants can watch (terminal:read)', () => {
    const grants: UserGrant[] = [{ scope: 'claude://default/Users/jonas/projects/x', permissions: ['terminal:read'] }]
    const visible = filterRosterForGrants(rosterEntries, grants)
    expect(visible.map(e => e.shellId)).toEqual(['x'])
  })

  it('hides every shell from a viewer with no terminal:read', () => {
    const grants: UserGrant[] = [{ scope: '*', permissions: ['chat:read'] }]
    expect(filterRosterForGrants(rosterEntries, grants)).toHaveLength(0)
  })

  it('buildRosterSnapshot shapes a filtered shell_roster message', () => {
    const r = new BrokerShellRegistry()
    for (const e of rosterEntries) r.add(e)
    const grants: UserGrant[] = [{ scope: 'claude://default/Users/jonas/projects/y', permissions: ['terminal:read'] }]
    const snap = buildRosterSnapshot(r, grants)
    expect(snap.type).toBe('shell_roster')
    expect(snap.shells.map(s => s.shellId)).toEqual(['y'])
  })
})
