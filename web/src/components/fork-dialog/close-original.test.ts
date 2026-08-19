/**
 * @vitest-environment node
 */
/**
 * The "close the original" default.
 *
 * This decides whether a destructive checkbox arrives pre-ticked, so every rule
 * gets a case: closing something a human is actively using is the failure this
 * file exists to prevent.
 */

import { describe, expect, test } from 'vitest'
import type { Conversation } from '@/lib/types'
import { canCloseOriginal, defaultCloseOriginal, hasRecentActivity } from './close-original'

const NOW = 1_800_000_000_000
const MIN = 60_000

const conv = (patch: Partial<Conversation>): Conversation =>
  ({ id: 'conv_1', status: 'idle', lastActivity: 0, ...patch }) as Conversation

describe('canCloseOriginal', () => {
  test('an ended conversation offers no checkbox', () => {
    expect(canCloseOriginal(conv({ status: 'ended' }))).toBe(false)
  })

  test('a missing conversation offers no checkbox', () => {
    expect(canCloseOriginal(undefined)).toBe(false)
  })

  test('a live conversation offers the checkbox', () => {
    expect(canCloseOriginal(conv({ status: 'idle' }))).toBe(true)
  })
})

describe('hasRecentActivity', () => {
  test('a running conversation counts regardless of timestamps', () => {
    expect(hasRecentActivity(conv({ status: 'active', lastActivity: 0 }), NOW)).toBe(true)
  })

  test('idle is not activity -- only the timestamps are', () => {
    expect(hasRecentActivity(conv({ status: 'idle', lastActivity: NOW - 90 * MIN }), NOW)).toBe(false)
  })

  test('the newest of the three signals wins', () => {
    const c = conv({ lastActivity: NOW - 90 * MIN, lastInputAt: 0, lastTurnEndedAt: NOW - 2 * MIN })
    expect(hasRecentActivity(c, NOW)).toBe(true)
  })

  test('exactly 30 minutes old is already stale', () => {
    expect(hasRecentActivity(conv({ lastActivity: NOW - 30 * MIN }), NOW)).toBe(false)
    expect(hasRecentActivity(conv({ lastActivity: NOW - 30 * MIN + 1 }), NOW)).toBe(true)
  })
})

describe('defaultCloseOriginal', () => {
  test('OFF while the conversation is working', () => {
    expect(defaultCloseOriginal(conv({ status: 'active' }), NOW)).toBe(false)
  })

  test('OFF after activity inside the last 30 minutes', () => {
    expect(defaultCloseOriginal(conv({ lastActivity: NOW - 5 * MIN }), NOW)).toBe(false)
  })

  test('ON once the conversation has been quiet for 30+ minutes', () => {
    expect(defaultCloseOriginal(conv({ lastActivity: NOW - 31 * MIN }), NOW)).toBe(true)
  })

  test('ON when activity is unknown -- unknown is not recent', () => {
    expect(defaultCloseOriginal(conv({ lastActivity: 0 }), NOW)).toBe(true)
  })

  test('OFF for an ended conversation -- nothing to close', () => {
    expect(defaultCloseOriginal(conv({ status: 'ended', lastActivity: 0 }), NOW)).toBe(false)
  })
})
