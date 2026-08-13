/**
 * The recent window is a UNION of two bounds, and unions are where off-by-one
 * reasoning goes wrong: a pure count truncates a busy day, a pure age returns
 * nothing for a quiet project. These pin the semantics before any storage
 * concern touches them.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_RECENT_HARD_CAP,
  DEFAULT_RECENT_MIN_COUNT,
  recentCutoff,
  recentLimit,
  resolveRecentWindow,
} from '../recent-window'

const window = resolveRecentWindow()

describe('recentLimit', () => {
  test('a quiet project still returns the minimum count', () => {
    // Nothing inside the age window: the count half carries it.
    expect(recentLimit(window, 0)).toBe(DEFAULT_RECENT_MIN_COUNT)
  })

  test('a busy project returns everything inside the age window', () => {
    // 300 ended in the last five days is more than the floor, so the age half wins.
    expect(recentLimit(window, 300)).toBe(300)
  })

  test('the hard cap beats both halves', () => {
    expect(recentLimit(window, 5000)).toBe(DEFAULT_RECENT_HARD_CAP)
  })

  test('exactly at the floor, neither half changes the answer', () => {
    expect(recentLimit(window, DEFAULT_RECENT_MIN_COUNT)).toBe(DEFAULT_RECENT_MIN_COUNT)
  })

  test('a caller can tighten every bound', () => {
    const tight = resolveRecentWindow({ minCount: 5, hardCap: 10 })
    expect(recentLimit(tight, 0)).toBe(5)
    expect(recentLimit(tight, 8)).toBe(8)
    expect(recentLimit(tight, 99)).toBe(10)
  })
})

describe('recentCutoff', () => {
  test('is five days back by default', () => {
    const now = 1_000_000_000_000
    expect(recentCutoff(window, now)).toBe(now - 5 * 24 * 60 * 60 * 1000)
  })
})
