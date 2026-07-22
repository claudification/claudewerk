import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdleTimeout } from './use-idle-timeout'

const TOTAL = 300_000
const LEAD = 30_000

function setup(over: Partial<Parameters<typeof useIdleTimeout>[0]> = {}) {
  const onWarn = vi.fn()
  const onTimeout = vi.fn()
  const props = { active: true, totalMs: TOTAL, warnLeadMs: LEAD, onWarn, onTimeout, ...over }
  const view = renderHook(p => useIdleTimeout(p), { initialProps: props })
  return { view, onWarn, onTimeout, props }
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useIdleTimeout', () => {
  it('warns a fixed lead before it fires, then times out', () => {
    const { view, onWarn, onTimeout } = setup()
    advance(TOTAL - LEAD - 1)
    expect(onWarn).not.toHaveBeenCalled()
    advance(1)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(view.result.current.warning).toBe(true)
    advance(LEAD)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(view.result.current.warning).toBe(false)
  })

  it('a pulse re-arms from zero and dismisses an open warning', () => {
    const { view, onTimeout } = setup()
    advance(TOTAL - LEAD)
    expect(view.result.current.warning).toBe(true)
    act(() => view.result.current.pulse())
    expect(view.result.current.warning).toBe(false)
    advance(TOTAL - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    advance(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('counts down while warning', () => {
    const { view } = setup({ tickMs: 1000 })
    advance(TOTAL - LEAD)
    expect(view.result.current.remainingMs).toBe(LEAD)
    advance(3000)
    expect(view.result.current.remainingMs).toBe(LEAD - 3000)
  })

  it('never fires while inactive, and a pulse cannot arm it', () => {
    const { view, onTimeout, onWarn } = setup({ active: false })
    act(() => view.result.current.pulse())
    advance(TOTAL * 2)
    expect(onWarn).not.toHaveBeenCalled()
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('going inactive clears a pending timeout AND an open warning', () => {
    const { view, onTimeout, props } = setup()
    advance(TOTAL - LEAD)
    expect(view.result.current.warning).toBe(true)
    act(() => view.rerender({ ...props, active: false }))
    expect(view.result.current.warning).toBe(false)
    advance(TOTAL * 2)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('re-activating starts a fresh full span', () => {
    const { view, onTimeout, props } = setup({ active: false })
    act(() => view.rerender({ ...props, active: true }))
    advance(TOTAL - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    advance(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('unmounting leaves no timer to fire into a dead component', () => {
    const { view, onTimeout } = setup()
    view.unmount()
    advance(TOTAL * 2)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('reads the LATEST callback, not the one captured when armed', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { view, props } = setup({ onTimeout: first })
    act(() => view.rerender({ ...props, onTimeout: second }))
    advance(TOTAL)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
