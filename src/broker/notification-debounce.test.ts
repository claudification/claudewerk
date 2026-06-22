import { describe, expect, it } from 'bun:test'
import { DEFAULT_NOTIFY_WINDOW_MS, NotificationDebouncer } from './notification-debounce'

describe('NotificationDebouncer', () => {
  it('allows the first notification and suppresses repeats within the window', () => {
    const d = new NotificationDebouncer({ windowMs: 1000 })
    expect(d.shouldNotify('k', 0)).toBe(true)
    expect(d.shouldNotify('k', 1)).toBe(false)
    expect(d.shouldNotify('k', 1000)).toBe(false) // exactly windowMs later -> still suppressed (strict >)
  })

  it('allows again once the window has fully elapsed', () => {
    const d = new NotificationDebouncer({ windowMs: 1000 })
    expect(d.shouldNotify('k', 0)).toBe(true)
    expect(d.shouldNotify('k', 1001)).toBe(true) // > windowMs past the recorded hit
    expect(d.shouldNotify('k', 1500)).toBe(false) // window restarts from 1001
  })

  it('tracks keys independently', () => {
    const d = new NotificationDebouncer({ windowMs: 1000 })
    expect(d.shouldNotify('a', 0)).toBe(true)
    expect(d.shouldNotify('b', 0)).toBe(true)
    expect(d.shouldNotify('a', 100)).toBe(false)
    expect(d.shouldNotify('b', 100)).toBe(false)
  })

  it('reset(key) re-arms a single key', () => {
    const d = new NotificationDebouncer({ windowMs: 1000 })
    expect(d.shouldNotify('a', 0)).toBe(true)
    expect(d.shouldNotify('b', 0)).toBe(true)
    d.reset('a')
    expect(d.shouldNotify('a', 100)).toBe(true) // re-armed -> fires immediately
    expect(d.shouldNotify('b', 100)).toBe(false) // untouched
  })

  it('reset() with no key clears everything', () => {
    const d = new NotificationDebouncer({ windowMs: 1000 })
    expect(d.shouldNotify('a', 0)).toBe(true)
    expect(d.shouldNotify('b', 0)).toBe(true)
    d.reset()
    expect(d.shouldNotify('a', 100)).toBe(true)
    expect(d.shouldNotify('b', 100)).toBe(true)
  })

  it('canNotify checks without recording', () => {
    const d = new NotificationDebouncer({ windowMs: 1000 })
    expect(d.canNotify('k', 0)).toBe(true)
    expect(d.canNotify('k', 0)).toBe(true) // still true -- nothing was recorded
    expect(d.shouldNotify('k', 0)).toBe(true) // records now
    expect(d.canNotify('k', 500)).toBe(false)
    expect(d.canNotify('k', 1001)).toBe(true)
  })

  it('exposes a 10-minute default window', () => {
    expect(DEFAULT_NOTIFY_WINDOW_MS).toBe(600_000)
  })
})
