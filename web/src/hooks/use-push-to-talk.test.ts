import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePushToTalk } from './use-push-to-talk'

vi.mock('@/hooks/voice-prewarm', () => ({ prewarmVoice: vi.fn(), prewarmVoiceTransport: vi.fn() }))
vi.mock('@/lib/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  haptic: vi.fn(),
}))

/**
 * THE CHORD COLLISION (2026-08-18): the Pulse strip peeks on `mod+alt`. With
 * push-to-talk bound to an Alt key, that same hold opened the microphone --
 * reaching for a glance at the fleet started recording you.
 */
function setup(holdKey: string | null = 'AltLeft', over: { needsUnlock?: boolean } = {}) {
  const voice = { start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }
  const unlock = vi.fn()
  const permission = { needsUnlock: over.needsUnlock ?? false, unlock }
  const view = renderHook(() =>
    usePushToTalk({
      holdKey,
      keepMicOpen: false,
      voice: voice as never,
      permission: permission as never,
    }),
  )
  return { voice, unlock, view }
}

const down = (code: string, mods: Partial<KeyboardEventInit> = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { code, cancelable: true, ...mods }))
const up = (code: string) => window.dispatchEvent(new KeyboardEvent('keyup', { code, cancelable: true }))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('usePushToTalk — the grace window', () => {
  it('does not start the instant the key goes down', () => {
    const { voice } = setup()
    down('AltLeft', { altKey: true })
    expect(voice.start).not.toHaveBeenCalled()
  })

  it('starts once the window elapses with nothing else pressed', () => {
    const { voice } = setup()
    down('AltLeft', { altKey: true })
    vi.advanceTimersByTime(70)
    expect(voice.start).toHaveBeenCalledOnce()
  })

  it('ABANDONS the start when a second key lands inside the window', () => {
    // Alt first, then Cmd: nothing on the Alt keydown said a chord was coming.
    const { voice } = setup()
    down('AltLeft', { altKey: true })
    down('MetaLeft', { altKey: true, metaKey: true })
    vi.advanceTimersByTime(500)
    expect(voice.start).not.toHaveBeenCalled()
  })

  it('never starts at all when the modifier was ALREADY down', () => {
    // Cmd first, then Alt: knowable immediately, no waiting required.
    const { voice } = setup()
    down('AltLeft', { altKey: true, metaKey: true })
    vi.advanceTimersByTime(500)
    expect(voice.start).not.toHaveBeenCalled()
  })

  it('leaves a chord keydown uncancelled so the chord owner still sees it', () => {
    setup()
    const e = new KeyboardEvent('keydown', { code: 'AltLeft', altKey: true, metaKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('does not start on a press released inside the window', () => {
    const { voice } = setup()
    down('AltLeft', { altKey: true })
    up('AltLeft')
    vi.advanceTimersByTime(500)
    expect(voice.start).not.toHaveBeenCalled()
    expect(voice.stop).not.toHaveBeenCalled()
  })

  it('stops on release after a real start', () => {
    const { voice } = setup()
    down('AltLeft', { altKey: true })
    vi.advanceTimersByTime(70)
    up('AltLeft')
    expect(voice.stop).toHaveBeenCalledOnce()
  })

  it('ignores auto-repeat', () => {
    const { voice } = setup()
    down('AltLeft', { altKey: true })
    down('AltLeft', { altKey: true, repeat: true })
    vi.advanceTimersByTime(70)
    expect(voice.start).toHaveBeenCalledOnce()
  })

  it('runs the unlock probe IMMEDIATELY, not behind the window', () => {
    // getUserMedia has to run inside the user gesture or the platform refuses.
    const { unlock, voice } = setup('AltLeft', { needsUnlock: true })
    down('AltLeft', { altKey: true })
    expect(unlock).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(500)
    expect(voice.start).not.toHaveBeenCalled()
  })

  it('cancels a pending start when the hook unmounts', () => {
    const { voice, view } = setup()
    down('AltLeft', { altKey: true })
    view.unmount()
    vi.advanceTimersByTime(500)
    expect(voice.start).not.toHaveBeenCalled()
  })

  it('does nothing at all with no hold key bound', () => {
    const { voice } = setup(null)
    down('AltLeft', { altKey: true })
    vi.advanceTimersByTime(500)
    expect(voice.start).not.toHaveBeenCalled()
  })

  it('works for a non-modifier hold key, which has no chord to fear', () => {
    const { voice } = setup('F13')
    down('F13')
    vi.advanceTimersByTime(70)
    expect(voice.start).toHaveBeenCalledOnce()
  })
})
