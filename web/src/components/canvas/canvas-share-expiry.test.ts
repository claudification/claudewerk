/**
 * formatRemaining -- the share countdown. A link that reads "1h left" when it is
 * already dead is worse than no countdown, so the boundary cases matter.
 */

// web/ runs on vitest (`bun run test`), NOT bun:test -- a bun:test import here
// fails the whole suite to load ("Cannot bundle Node.js built-in bun:test").
import { expect, test } from 'vitest'
import { formatRemaining } from './canvas-share-expiry'

const NOW = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

test('null once the deadline has passed', () => {
  expect(formatRemaining(NOW - 1, NOW)).toBeNull()
  expect(formatRemaining(NOW, NOW)).toBeNull()
})

test('minutes under the hour, never rounding down to zero', () => {
  expect(formatRemaining(NOW + 30 * MIN, NOW)).toBe('30m left')
  expect(formatRemaining(NOW + 1_000, NOW)).toBe('1m left') // <1min still reads as 1
})

test('hours up to two days', () => {
  expect(formatRemaining(NOW + HOUR, NOW)).toBe('1h left')
  expect(formatRemaining(NOW + 47 * HOUR, NOW)).toBe('47h left')
})

test('days beyond that', () => {
  expect(formatRemaining(NOW + 48 * HOUR, NOW)).toBe('2d left')
  expect(formatRemaining(NOW + 7 * 24 * HOUR, NOW)).toBe('7d left')
})
