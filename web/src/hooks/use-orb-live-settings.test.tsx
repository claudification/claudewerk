import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny stand-in for the zustand store: selector reads the mutable `state`, and
// the test drives re-renders with rerender() after mutating it.
const state = { controlPanelPrefs: { voiceOrbSpeed: 1.3, voiceOrbVoice: 'marin' } }
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
}))

const { useOrbLiveSettings, orbSpeed } = await import('./use-orb-live-settings')

const liveSession = () => ({ session: { setSpeed: vi.fn() } })

afterEach(cleanup)
beforeEach(() => {
  state.controlPanelPrefs = { voiceOrbSpeed: 1.3, voiceOrbVoice: 'marin' }
})

describe('orbSpeed', () => {
  it('clamps to the API range and falls back on junk', () => {
    state.controlPanelPrefs.voiceOrbSpeed = 9
    expect(orbSpeed()).toBe(1.5)
    state.controlPanelPrefs.voiceOrbSpeed = 0.1
    expect(orbSpeed()).toBe(0.25)
    state.controlPanelPrefs.voiceOrbSpeed = Number.NaN
    expect(orbSpeed()).toBe(1.3)
  })
})

describe('useOrbLiveSettings', () => {
  it('pushes a speed change straight into the live session (speed IS live)', () => {
    const live = liveSession()
    const onVoice = vi.fn()
    const { rerender } = renderHook(({ l }) => useOrbLiveSettings(l, onVoice), { initialProps: { l: live } })
    expect(live.session.setSpeed).toHaveBeenLastCalledWith(1.3)
    state.controlPanelPrefs = { ...state.controlPanelPrefs, voiceOrbSpeed: 1.5 }
    rerender({ l: live })
    expect(live.session.setSpeed).toHaveBeenLastCalledWith(1.5)
    expect(onVoice).not.toHaveBeenCalled()
  })

  it('a voice change asks for a RESTART, and never on the first (mint) run', () => {
    const live = liveSession()
    const onVoice = vi.fn()
    const { rerender } = renderHook(({ l }) => useOrbLiveSettings(l, onVoice), { initialProps: { l: live } })
    // First run is the value the session was just minted with -- no restart.
    expect(onVoice).not.toHaveBeenCalled()
    state.controlPanelPrefs = { ...state.controlPanelPrefs, voiceOrbVoice: 'cedar' }
    rerender({ l: live })
    expect(onVoice).toHaveBeenCalledTimes(1)
  })

  it('a voice change with NO live session does nothing (waits for next summon)', () => {
    const onVoice = vi.fn()
    const { rerender } = renderHook(({ l }) => useOrbLiveSettings(l, onVoice), {
      initialProps: { l: null as { session: { setSpeed(n: number): void } } | null },
    })
    state.controlPanelPrefs = { ...state.controlPanelPrefs, voiceOrbVoice: 'cedar' }
    rerender({ l: null })
    expect(onVoice).not.toHaveBeenCalled()
  })
})
