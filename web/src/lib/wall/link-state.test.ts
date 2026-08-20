import { describe, expect, it } from 'vitest'
import { wallLinkState } from './link-state'
import type { WallFreshness } from './revive-store'

const landed: WallFreshness = { loaded: true, stale: false, at: 1 }
const stale: WallFreshness = { loaded: true, stale: true, at: 1 }
const never: WallFreshness = { loaded: false, stale: false, at: null }

describe('the wall link state', () => {
  it('is LIVE only when the socket is up and every feed landed on this connection', () => {
    const view = wallLinkState({ connected: true, feeds: [landed, landed] })
    expect(view.label).toBe('LIVE')
    expect(view.pulse).toBe(true)
  })

  /** The dot used to pulse green through this exact case. */
  it('is OFFLINE with the socket down, whatever the feeds say', () => {
    const view = wallLinkState({ connected: false, feeds: [landed, landed] })
    expect(view.label).toBe('OFFLINE')
    expect(view.pulse).toBe(false)
  })

  it('is LOADING while a feed has never landed', () => {
    expect(wallLinkState({ connected: true, feeds: [landed, never] }).label).toBe('LOADING')
  })

  it('is SYNCING when a feed landed on an EARLIER connection -- the pane is pre-disconnect', () => {
    const view = wallLinkState({ connected: true, feeds: [landed, stale] })
    expect(view.label).toBe('SYNCING')
    expect(view.why).toContain('pre-disconnect')
  })

  it('never pulses on anything but LIVE', () => {
    const inputs = [
      { connected: false, feeds: [] },
      { connected: true, feeds: [never] },
      { connected: true, feeds: [stale] },
    ]
    expect(inputs.map(i => wallLinkState(i).pulse)).toEqual([false, false, false])
  })

  it('an empty wall with a live socket is LIVE, not LOADING -- no feed is not a late feed', () => {
    expect(wallLinkState({ connected: true, feeds: [] }).label).toBe('LIVE')
  })

  it('always explains itself', () => {
    const inputs = [
      { connected: false, feeds: [] },
      { connected: true, feeds: [never] },
      { connected: true, feeds: [stale] },
      { connected: true, feeds: [landed] },
    ]
    for (const input of inputs) expect(wallLinkState(input).why.length).toBeGreaterThan(20)
  })
})
