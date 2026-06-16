import { describe, expect, it } from 'bun:test'
import type { ProfileUsageSnapshot } from '../../shared/protocol'
import {
  applyInferenceReading,
  type InferenceUsageEntry,
  mergeProfileUsage,
  rateLimitTypeToWindow,
  USAGE_FRESHNESS_MS,
} from './usage-merge'

const NOW = 1_000_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

function poll(over: Partial<ProfileUsageSnapshot> = {}): ProfileUsageSnapshot {
  return {
    profile: 'default',
    authed: true,
    polledAt: NOW - 60_000,
    fiveHour: { usedPercent: 10, resetAt: iso(NOW + 3_600_000) },
    sevenDay: { usedPercent: 40, resetAt: iso(NOW + 6 * 86_400_000) },
    ...over,
  }
}

describe('rateLimitTypeToWindow', () => {
  it('maps CC representative-claim names to snapshot windows', () => {
    expect(rateLimitTypeToWindow('five_hour')).toBe('fiveHour')
    expect(rateLimitTypeToWindow('seven_day')).toBe('sevenDay')
    expect(rateLimitTypeToWindow('seven_day_opus')).toBe('sevenDayOpus')
    expect(rateLimitTypeToWindow('overage')).toBeUndefined()
    expect(rateLimitTypeToWindow(undefined)).toBeUndefined()
  })
})

describe('applyInferenceReading', () => {
  it('keeps the freshest reading per window', () => {
    const e: InferenceUsageEntry = {}
    applyInferenceReading(e, 'fiveHour', { usedPercent: 50, resetAt: iso(NOW), observedAt: NOW })
    applyInferenceReading(e, 'fiveHour', { usedPercent: 95, resetAt: iso(NOW), observedAt: NOW + 1000 })
    expect(e.fiveHour?.usedPercent).toBe(95)
    // Older reading is ignored.
    applyInferenceReading(e, 'fiveHour', { usedPercent: 12, resetAt: iso(NOW), observedAt: NOW - 5000 })
    expect(e.fiveHour?.usedPercent).toBe(95)
  })
})

describe('mergeProfileUsage', () => {
  it('overlays a fresher inference window onto the poll snapshot', () => {
    const inference: InferenceUsageEntry = {
      fiveHour: { usedPercent: 95, resetAt: iso(NOW + 1800_000), observedAt: NOW },
    }
    const merged = mergeProfileUsage('default', poll(), inference, NOW)
    expect(merged.fiveHour?.usedPercent).toBe(95) // from inference (fresher)
    expect(merged.sevenDay?.usedPercent).toBe(40) // from poll (inference didn't touch it)
    expect(merged.polledAt).toBe(NOW)
    expect(merged.stale).toBeUndefined()
  })

  it('surfaces inference data when the poll is 429-errored (no windows)', () => {
    const errored: ProfileUsageSnapshot = {
      profile: 'default',
      authed: true,
      polledAt: NOW,
      error: { kind: 'http', status: 429, detail: 'Rate limited' },
    }
    const inference: InferenceUsageEntry = {
      fiveHour: { usedPercent: 88, resetAt: iso(NOW + 1800_000), observedAt: NOW },
    }
    const merged = mergeProfileUsage('default', errored, inference, NOW)
    expect(merged.error).toBeUndefined()
    expect(merged.fiveHour?.usedPercent).toBe(88)
    expect(merged.authed).toBe(true)
  })

  it('keeps the carried-forward 7d while inference refreshes 5h, and is not stale', () => {
    const carried = poll({ polledAt: NOW - 50 * 60_000, stale: true })
    const inference: InferenceUsageEntry = {
      fiveHour: { usedPercent: 70, resetAt: iso(NOW + 1800_000), observedAt: NOW - 1000 },
    }
    const merged = mergeProfileUsage('default', carried, inference, NOW)
    expect(merged.fiveHour?.usedPercent).toBe(70) // inference (fresher than the 50m-old poll)
    expect(merged.sevenDay?.usedPercent).toBe(40) // carried poll
    expect(merged.stale).toBeUndefined() // newest contributor (inference) is fresh
  })

  it('marks stale when every contributing reading is old', () => {
    const old = poll({ polledAt: NOW - (USAGE_FRESHNESS_MS + 60_000) })
    const merged = mergeProfileUsage('default', old, undefined, NOW)
    expect(merged.stale).toBe(true)
  })

  it('returns the poll snapshot verbatim when neither source has windows', () => {
    const errored: ProfileUsageSnapshot = { profile: 'default', authed: true, polledAt: NOW, error: { kind: 'no_token' } }
    expect(mergeProfileUsage('default', errored, undefined, NOW)).toBe(errored)
  })
})
