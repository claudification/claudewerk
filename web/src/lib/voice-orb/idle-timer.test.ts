import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleTimer } from './idle-timer'

const SPEC = { totalMs: 300_000, warnLeadMs: 30_000, tickMs: 1000 }

function build(spec = SPEC) {
  const onWarn = vi.fn()
  const onTimeout = vi.fn()
  const remaining: number[] = []
  const timer = new IdleTimer(() => ({
    spec,
    handlers: { onWarn, onTimeout, onRemaining: ms => remaining.push(ms) },
  }))
  return { timer, onWarn, onTimeout, remaining }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('IdleTimer', () => {
  it('warns a fixed lead before the end, then fires', () => {
    const { timer, onWarn, onTimeout } = build()
    timer.arm()
    vi.advanceTimersByTime(SPEC.totalMs - SPEC.warnLeadMs - 1)
    expect(onWarn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onWarn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SPEC.warnLeadMs)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('counts down while warning and stops at zero', () => {
    const { timer, remaining } = build({ totalMs: 5000, warnLeadMs: 3000, tickMs: 1000 })
    timer.arm()
    vi.advanceTimersByTime(2000)
    expect(remaining).toEqual([3000])
    // The end fires before the tick that would land on the same millisecond and
    // clears the interval, so the countdown stops at the last whole step.
    vi.advanceTimersByTime(3000)
    expect(remaining).toEqual([3000, 2000, 1000])
  })

  it('re-arming from the warning window resets the whole span', () => {
    const { timer, onTimeout } = build()
    timer.arm()
    vi.advanceTimersByTime(SPEC.totalMs - 1)
    timer.arm()
    vi.advanceTimersByTime(SPEC.totalMs - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('clear() kills the warn, the end and the countdown', () => {
    const { timer, onWarn, onTimeout, remaining } = build()
    timer.arm()
    vi.advanceTimersByTime(SPEC.totalMs - SPEC.warnLeadMs)
    timer.clear()
    vi.advanceTimersByTime(SPEC.totalMs * 2)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(remaining).toEqual([SPEC.warnLeadMs])
  })

  it('fires only once -- the end clears its own timers', () => {
    const { timer, onTimeout } = build()
    timer.arm()
    vi.advanceTimersByTime(SPEC.totalMs * 3)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('picks up option changes without re-arming', () => {
    let spec = { ...SPEC }
    const onTimeout = vi.fn()
    const timer = new IdleTimer(() => ({
      spec,
      handlers: { onWarn: () => {}, onTimeout, onRemaining: () => {} },
    }))
    spec = { totalMs: 1000, warnLeadMs: 500, tickMs: 100 }
    timer.arm()
    vi.advanceTimersByTime(1000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})
