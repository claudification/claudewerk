/**
 * parseShareRequest -- the pure validation behind POST /api/canvases/:id/share.
 * Every rejection path matters: a bad tier or a silently-dropped expiry would
 * mint a link that outlives what the user asked for.
 */

import { expect, test } from 'bun:test'
import { parseShareRequest } from './canvases'

const HOUR = 60 * 60 * 1000

test('accepts each valid tier with no expiry', () => {
  for (const tier of ['read', 'comment', 'edit'] as const) {
    const res = parseShareRequest({ tier })
    expect(res).toEqual({ tier, expiresAt: null })
  }
})

test('rejects a missing or bogus tier', () => {
  expect(parseShareRequest(undefined)).toHaveProperty('error')
  expect(parseShareRequest({})).toHaveProperty('error')
  expect(parseShareRequest({ tier: 'admin' })).toHaveProperty('error')
  expect(parseShareRequest({ tier: 3 })).toHaveProperty('error')
})

test('turns expiresInHours into an absolute deadline', () => {
  const before = Date.now()
  const res = parseShareRequest({ tier: 'read', expiresInHours: 6 })
  if ('error' in res) throw new Error(res.error)
  expect(res.expiresAt).not.toBeNull()
  expect(res.expiresAt as number).toBeGreaterThanOrEqual(before + 6 * HOUR)
  expect(res.expiresAt as number).toBeLessThanOrEqual(Date.now() + 6 * HOUR)
})

test('null expiry means share until revoked', () => {
  expect(parseShareRequest({ tier: 'edit', expiresInHours: null })).toEqual({ tier: 'edit', expiresAt: null })
})

test('rejects non-positive, non-numeric and infinite durations', () => {
  for (const bad of [0, -1, 'soon', Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(parseShareRequest({ tier: 'read', expiresInHours: bad })).toHaveProperty('error')
  }
})

test('caps the duration at 30 days', () => {
  expect(parseShareRequest({ tier: 'read', expiresInHours: 30 * 24 })).not.toHaveProperty('error')
  expect(parseShareRequest({ tier: 'read', expiresInHours: 30 * 24 + 1 })).toHaveProperty('error')
})
