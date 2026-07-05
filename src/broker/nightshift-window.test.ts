/**
 * Window-time helper tests -- `computeWindowEndMs` (used by the capacity floor
 * ramp + starvation terminal). `withinWindow` itself is covered by the scheduler
 * test; this pins the "next close" math for straight + wrapping windows.
 */

import { describe, expect, test } from 'bun:test'
import { computeWindowEndMs } from './nightshift-window'

/** Local Date at h:m today, as epoch ms. */
function todayAt(h: number, m = 0): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime()
}
const DAY = 24 * 60 * 60 * 1000

describe('computeWindowEndMs', () => {
  test('non-clock / malformed windows -> undefined', () => {
    expect(computeWindowEndMs(undefined, todayAt(3))).toBeUndefined()
    expect(computeWindowEndMs('interactive load < 5', todayAt(3))).toBeUndefined()
  })

  test('straight window mid-run -> the end clock later today', () => {
    // running at 03:00 inside 01:00-07:00 -> close at 07:00 today.
    expect(computeWindowEndMs('01:00-07:00', todayAt(3))).toBe(todayAt(7))
  })

  test('end already passed today -> next occurrence tomorrow', () => {
    // running at 08:00, window end 07:00 already gone -> 07:00 tomorrow.
    expect(computeWindowEndMs('01:00-07:00', todayAt(8))).toBe(todayAt(7) + DAY)
  })

  test('wrapping window in the late-night leg -> close tomorrow morning', () => {
    // running at 23:30 inside 23:00-06:00 -> close at 06:00 tomorrow.
    expect(computeWindowEndMs('23:00-06:00', todayAt(23, 30))).toBe(todayAt(6) + DAY)
  })

  test('wrapping window in the early-morning leg -> close this morning', () => {
    // running at 02:00 inside 23:00-06:00 -> close at 06:00 today.
    expect(computeWindowEndMs('23:00-06:00', todayAt(2))).toBe(todayAt(6))
  })
})
