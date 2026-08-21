/**
 * The wall's period field: the four claims the card makes about it.
 *
 *  - the option list is exactly `1h 6h 24h 3d 7d 1m` and stops at the retention bound
 *  - it is ONE store, so two readers can never see two windows
 *  - it survives a reload (localStorage), unlike the filter and the cursor
 *  - a stored value that is no longer an option falls back to the default rather
 *    than reaching a feed as an unknown window
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WALL_PERIOD,
  loadWallPeriod,
  resetWallPeriod,
  useWallPeriodStore,
  WALL_PERIOD_MS,
  WALL_PERIODS,
  type WallPeriod,
} from './period-store'

const KEY = 'claudewerk.wallPeriod.v1'

beforeEach(() => {
  localStorage.clear()
  resetWallPeriod()
})

describe('the option list', () => {
  it('offers exactly the six windows the card asks for, in order', () => {
    expect(WALL_PERIODS).toEqual(['1h', '6h', '24h', '3d', '7d', '1m'])
  })

  it('opens on 24h -- what A2 hardcoded before the control existed', () => {
    expect(DEFAULT_WALL_PERIOD).toBe('24h')
    expect(useWallPeriodStore.getState().period).toBe('24h')
  })

  it('stops at the 30-day retention bound -- 1m is 30d, not a calendar month', () => {
    expect(WALL_PERIOD_MS['1m']).toBe(30 * 24 * 60 * 60_000)
    // Nothing offered may reach past what the stores keep.
    for (const p of WALL_PERIODS) expect(WALL_PERIOD_MS[p]).toBeLessThanOrEqual(WALL_PERIOD_MS['1m'])
  })

  it('gives every option a span, so no period can reach a feed unpriced', () => {
    for (const p of WALL_PERIODS) expect(WALL_PERIOD_MS[p]).toBeGreaterThan(0)
  })
})

describe('one source of truth', () => {
  it('publishes a write to every reader of the store', () => {
    useWallPeriodStore.getState().setPeriod('7d')
    expect(useWallPeriodStore.getState().period).toBe('7d')
  })

  it('ignores a no-op write, so nothing re-renders for it', () => {
    let bumps = 0
    const stop = useWallPeriodStore.subscribe(() => bumps++)
    useWallPeriodStore.getState().setPeriod(DEFAULT_WALL_PERIOD)
    expect(bumps).toBe(0)
    useWallPeriodStore.getState().setPeriod('6h')
    expect(bumps).toBe(1)
    stop()
  })
})

describe('it survives a reload', () => {
  it('writes the pick to localStorage', () => {
    useWallPeriodStore.getState().setPeriod('3d')
    expect(localStorage.getItem(KEY)).toBe('3d')
  })

  it('reads it back on the next load -- the reload simulation', () => {
    useWallPeriodStore.getState().setPeriod('1m')
    // What a fresh module init does.
    expect(loadWallPeriod()).toBe('1m')
  })

  it('falls back to the default for a value that is no longer an option', () => {
    localStorage.setItem(KEY, '90d')
    expect(loadWallPeriod()).toBe(DEFAULT_WALL_PERIOD)
  })

  it('falls back to the default for junk', () => {
    localStorage.setItem(KEY, '{"period":"7d"}')
    expect(loadWallPeriod()).toBe(DEFAULT_WALL_PERIOD)
  })

  it('round-trips every option it offers', () => {
    for (const p of WALL_PERIODS) {
      useWallPeriodStore.getState().setPeriod(p as WallPeriod)
      expect(loadWallPeriod()).toBe(p)
    }
  })
})
