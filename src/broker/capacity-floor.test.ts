/**
 * Time-aware capacity floor tests (§9c). Pure fn -- no clock, no ledger.
 */

import { describe, expect, test } from 'bun:test'
import { type CapacityFloorConfig, DEFAULT_CAPACITY_FLOOR, timeAwareFloorFraction } from './capacity-floor'

const HOUR = 60 * 60 * 1000
const cfg: CapacityFloorConfig = { baseFloorFraction: 0.1, morningRampMultiplier: 2, rampHours: 2 }

describe('timeAwareFloorFraction', () => {
  test('no window end -> flat base', () => {
    expect(timeAwareFloorFraction(cfg, 1_000_000)).toBeCloseTo(0.1, 6)
  })

  test('well before the ramp -> flat base', () => {
    const end = 100 * HOUR
    expect(timeAwareFloorFraction(cfg, end - 5 * HOUR, end)).toBeCloseTo(0.1, 6)
  })

  test('exactly at ramp start -> still base', () => {
    const end = 100 * HOUR
    expect(timeAwareFloorFraction(cfg, end - 2 * HOUR, end)).toBeCloseTo(0.1, 6)
  })

  test('halfway through the ramp -> halfway between base and peak', () => {
    const end = 100 * HOUR
    // 1h left of a 2h ramp: progressed 0.5 -> 0.1 + (0.2-0.1)*0.5 = 0.15
    expect(timeAwareFloorFraction(cfg, end - 1 * HOUR, end)).toBeCloseTo(0.15, 6)
  })

  test('at window end -> full peak (doubled)', () => {
    const end = 100 * HOUR
    expect(timeAwareFloorFraction(cfg, end, end)).toBeCloseTo(0.2, 6)
  })

  test('past window end -> holds the peak, never overshoots', () => {
    const end = 100 * HOUR
    expect(timeAwareFloorFraction(cfg, end + 10 * HOUR, end)).toBeCloseTo(0.2, 6)
  })

  test('multiplier <= 1 disables the ramp', () => {
    const flat = { ...cfg, morningRampMultiplier: 1 }
    const end = 100 * HOUR
    expect(timeAwareFloorFraction(flat, end, end)).toBeCloseTo(0.1, 6)
  })

  test('rampHours <= 0 disables the ramp', () => {
    const flat = { ...cfg, rampHours: 0 }
    const end = 100 * HOUR
    expect(timeAwareFloorFraction(flat, end, end)).toBeCloseTo(0.1, 6)
  })

  test('clamps a silly config below 1 so admission stays possible', () => {
    const silly: CapacityFloorConfig = { baseFloorFraction: 0.8, morningRampMultiplier: 2, rampHours: 2 }
    const end = 100 * HOUR
    // 0.8 * 2 = 1.6 -> clamped to 0.95 (never reserve the whole budget)
    expect(timeAwareFloorFraction(silly, end, end)).toBeCloseTo(0.95, 6)
  })

  test('negative/NaN base clamps to 0', () => {
    expect(timeAwareFloorFraction({ ...cfg, baseFloorFraction: -1 }, 0)).toBe(0)
    expect(timeAwareFloorFraction({ ...cfg, baseFloorFraction: Number.NaN }, 0)).toBe(0)
  })

  test('DEFAULT_CAPACITY_FLOOR ramps 0.1 -> 0.2', () => {
    const end = 100 * HOUR
    expect(timeAwareFloorFraction(DEFAULT_CAPACITY_FLOOR, end - 3 * HOUR, end)).toBeCloseTo(0.1, 6)
    expect(timeAwareFloorFraction(DEFAULT_CAPACITY_FLOOR, end, end)).toBeCloseTo(0.2, 6)
  })
})
