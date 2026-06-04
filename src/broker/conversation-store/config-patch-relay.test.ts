/**
 * Tier-1 unit tests for the broker side of Phase 8 (sentinel config patch):
 *   - the patchId-keyed listener registry (request/response correlation)
 *   - `applySentinelConfigSnapshot` (registry refresh from a post-apply
 *     `applied` snapshot + sentinel_status broadcast)
 *
 * Both are the broker plumbing the REST route + ack handler rely on.
 */
import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { createListenerRegistry } from './listeners'
import { applySentinelConfigSnapshot, buildSentinelList, createSentinelState, setSentinel } from './sentinel'
import type { ControlPanelMessage } from './types'

/** A throwaway ws stand-in -- the registry only stores it by identity. */
function fakeWs(): ServerWebSocket<unknown> {
  return {} as ServerWebSocket<unknown>
}

describe('listener registry -- patch correlation', () => {
  it('resolves a pending patch listener exactly once and reports a match', () => {
    const reg = createListenerRegistry()
    let got: unknown = null
    reg.addPatchListener('p1', r => {
      got = r
    })
    const matched = reg.resolvePatch('p1', { ok: true })
    expect(matched).toBe(true)
    expect(got).toEqual({ ok: true })
    // Second resolve is a no-op (listener already consumed).
    expect(reg.resolvePatch('p1', { ok: false })).toBe(false)
  })

  it('returns false when no listener is waiting (late / unmatched ack)', () => {
    const reg = createListenerRegistry()
    expect(reg.resolvePatch('unknown', { ok: true })).toBe(false)
  })

  it('removePatchListener cancels a pending wait', () => {
    const reg = createListenerRegistry()
    reg.addPatchListener('p2', () => {
      throw new Error('should not fire')
    })
    reg.removePatchListener('p2')
    expect(reg.resolvePatch('p2', { ok: true })).toBe(false)
  })
})

describe('applySentinelConfigSnapshot', () => {
  // fallow-ignore-next-line complexity
  it('refreshes the stored profile registry and broadcasts sentinel_status', () => {
    const state = createSentinelState()
    const broadcasts: ControlPanelMessage[] = []
    const broadcast = (m: ControlPanelMessage) => broadcasts.push(m)
    // Register a connected sentinel with an initial profile slice.
    setSentinel(state, fakeWs(), broadcast, {
      sentinelId: 'snt_1',
      alias: 'beast',
      profiles: [{ name: 'work', pool: 'main', weight: 1, authed: true }],
      defaultSelection: 'balanced',
      pools: ['main'],
      defaultPool: 'main',
    })
    broadcasts.length = 0

    const applied = applySentinelConfigSnapshot(
      state,
      'snt_1',
      {
        profiles: [{ name: 'work', pool: 'alt', weight: 5, authed: true }],
        defaultSelection: 'random',
        pools: ['alt'],
        defaultPool: 'alt',
      },
      broadcast,
    )

    expect(applied).toBe(true)
    const conn = state.sentinels.get('snt_1')
    expect(conn?.profiles?.[0]).toMatchObject({ name: 'work', pool: 'alt', weight: 5 })
    expect(conn?.defaultSelection).toBe('random')
    expect(conn?.pools).toEqual(['alt'])
    expect(conn?.defaultPool).toBe('alt')
    // A fresh sentinel_status was broadcast so the control panel updates.
    expect(broadcasts.some(m => m.type === 'sentinel_status')).toBe(true)
  })

  it('returns false for an unknown / disconnected sentinel', () => {
    const state = createSentinelState()
    const applied = applySentinelConfigSnapshot(state, 'snt_missing', { defaultSelection: 'random' }, () => {})
    expect(applied).toBe(false)
  })

  it('leaves untouched fields alone when the snapshot omits them', () => {
    const state = createSentinelState()
    setSentinel(state, fakeWs(), () => {}, {
      sentinelId: 'snt_2',
      alias: 'box',
      profiles: [{ name: 'work', pool: 'main', weight: 1, authed: true }],
      defaultSelection: 'balanced',
      pools: ['main'],
      defaultPool: 'main',
    })
    // Only defaultPool in the snapshot.
    applySentinelConfigSnapshot(state, 'snt_2', { defaultPool: 'other' }, () => {})
    const conn = state.sentinels.get('snt_2')
    expect(conn?.defaultPool).toBe('other')
    // profiles + defaultSelection unchanged.
    expect(conn?.defaultSelection).toBe('balanced')
    expect(conn?.profiles?.[0].weight).toBe(1)
  })
})

describe('buildSentinelList -- shellCapable advertisement', () => {
  it('surfaces the sentinel-reported features.shell so the control panel can gate', () => {
    const state = createSentinelState()
    setSentinel(state, fakeWs(), () => {}, { sentinelId: 'snt_yes', alias: 'mac', features: { shell: true } })
    setSentinel(state, fakeWs(), () => {}, { sentinelId: 'snt_no', alias: 'pi', features: { shell: false } })
    // No features reported at all -> defaults to not shell-capable (never undefined).
    setSentinel(state, fakeWs(), () => {}, { sentinelId: 'snt_bare', alias: 'box' })

    const byAlias = Object.fromEntries(buildSentinelList(state).map(s => [s.alias, s.shellCapable]))
    expect(byAlias.mac).toBe(true)
    expect(byAlias.pi).toBe(false)
    expect(byAlias.box).toBe(false)
  })
})
