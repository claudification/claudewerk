import { describe, expect, it } from 'vitest'
import { toOrbState } from './orb-state'

describe('toOrbState', () => {
  it('shows the session state directly while the orb is engaged', () => {
    expect(toOrbState('speaking', false, false)).toBe('speaking')
    expect(toOrbState('thinking', false, false)).toBe('thinking')
    expect(toOrbState('connecting', false, false)).toBe('connecting')
  })

  it('falls back to listening for anything else', () => {
    expect(toOrbState('listening', false, false)).toBe('listening')
    expect(toOrbState('idle', false, false)).toBe('listening')
    expect(toOrbState('who-knows', false, false)).toBe('listening')
  })

  it('mute and doze both read as asleep, and they win over the session state', () => {
    expect(toOrbState('listening', true, false)).toBe('asleep')
    expect(toOrbState('listening', false, true)).toBe('asleep')
    // Muted mid-sentence: the orb must not look like it is still talking to you.
    expect(toOrbState('speaking', true, false)).toBe('asleep')
  })
})
