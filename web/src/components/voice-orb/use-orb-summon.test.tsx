import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOZE_MS, IDLE_TIMEOUT_MS, IDLE_WARN_LEAD_MS, useOrbSummon } from './use-orb-summon'
import { voiceOrbBus } from './voice-orb-bus'

function setup(over: Partial<Parameters<typeof useOrbSummon>[0]> = {}) {
  const start = vi.fn()
  const stop = vi.fn()
  const input = { start, stop, live: false, error: null, activity: 'idle:', ...over }
  const view = renderHook(props => useOrbSummon(props), { initialProps: input })
  return { view, start, stop, input }
}

const summon = () => act(() => voiceOrbBus.open('summon'))
const toggle = () => act(() => voiceOrbBus.open('toggle'))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  voiceOrbBus.setHandler(null)
})

describe('summon latch', () => {
  it('starts the session when summoned', () => {
    const { view, start } = setup()
    expect(view.result.current.summoned).toBe(false)
    summon()
    expect(view.result.current.summoned).toBe(true)
    expect(start).toHaveBeenCalled()
  })

  it('toggle dismisses a present orb and STOPS the session (mic release)', () => {
    const { view, stop } = setup()
    toggle()
    expect(view.result.current.summoned).toBe(true)
    toggle()
    expect(view.result.current.summoned).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('summon is idempotent -- no second start on a second summon', () => {
    const { start } = setup()
    summon()
    summon()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('dismiss() from the UI stops the session too', () => {
    const { view, stop } = setup()
    summon()
    act(() => view.result.current.dismiss())
    expect(view.result.current.summoned).toBe(false)
    expect(stop).toHaveBeenCalled()
  })

  it('un-summons when the session dies on its own, so no dead orb lingers', () => {
    const { view, input } = setup()
    summon()
    act(() => view.rerender({ ...input, live: false, error: 'peer connection failed' }))
    expect(view.result.current.summoned).toBe(false)
  })

  it('stays summoned while a live session reports no error', () => {
    const { view, input } = setup()
    summon()
    act(() => view.rerender({ ...input, live: true, error: null }))
    expect(view.result.current.summoned).toBe(true)
  })
})

describe('doze', () => {
  it('dozes after quiet and wakes on the next activity', () => {
    const { view, input } = setup()
    summon()
    expect(view.result.current.dozing).toBe(false)
    act(() => vi.advanceTimersByTime(DOZE_MS))
    expect(view.result.current.dozing).toBe(true)
    act(() => view.rerender({ ...input, activity: 'speaking:hello' }))
    expect(view.result.current.dozing).toBe(false)
  })

  it('never dozes while away', () => {
    const { view } = setup()
    act(() => vi.advanceTimersByTime(DOZE_MS * 3))
    expect(view.result.current.dozing).toBe(false)
  })
})

describe('idle: the orb leaves rather than holding a hot mic forever', () => {
  it('warns near the end, then steps away -- stopping the session', () => {
    const { view, stop } = setup()
    summon()
    act(() => vi.advanceTimersByTime(IDLE_TIMEOUT_MS - IDLE_WARN_LEAD_MS))
    expect(view.result.current.leavingSoon).toBe(true)
    expect(view.result.current.summoned).toBe(true)
    act(() => vi.advanceTimersByTime(IDLE_WARN_LEAD_MS))
    expect(view.result.current.summoned).toBe(false)
    expect(view.result.current.steppedAway).toBe(true)
    expect(stop).toHaveBeenCalled()
  })

  it('activity resets the whole span -- talking keeps it around', () => {
    const { view, input, stop } = setup()
    summon()
    act(() => vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1000))
    act(() => view.rerender({ ...input, activity: 'speaking:still here' }))
    expect(view.result.current.leavingSoon).toBe(false)
    act(() => vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1000))
    expect(view.result.current.summoned).toBe(true)
    expect(stop).not.toHaveBeenCalled()
  })

  it('never times out while away', () => {
    const { view, stop } = setup()
    act(() => vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2))
    expect(view.result.current.steppedAway).toBe(false)
    expect(stop).not.toHaveBeenCalled()
  })

  it('the notice is one-shot, and going away keeps it clear', () => {
    const { view } = setup()
    summon()
    act(() => vi.advanceTimersByTime(IDLE_TIMEOUT_MS))
    expect(view.result.current.steppedAway).toBe(true)
    act(() => view.result.current.acknowledgeSteppedAway())
    expect(view.result.current.steppedAway).toBe(false)
    act(() => vi.advanceTimersByTime(IDLE_TIMEOUT_MS))
    expect(view.result.current.steppedAway).toBe(false)
  })
})
