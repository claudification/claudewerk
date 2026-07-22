import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOZE_MS, useOrbSummon } from './use-orb-summon'
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
