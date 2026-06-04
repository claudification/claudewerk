import { describe, expect, it } from 'bun:test'
import type { RecapSignal } from '../../../shared/protocol'
import { recapCacheKey } from './orchestrator'

const base = {
  projectUri: 'claude://default/test',
  periodStart: 1000,
  periodEnd: 2000,
  audience: 'human' as const,
  customerFriendly: false,
  signals: ['commits', 'cost'] as RecapSignal[],
  template: 'project-recap',
  options: {} as Record<string, boolean>,
}

describe('recapCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(recapCacheKey(base)).toBe(recapCacheKey({ ...base }))
  })

  it('customerFriendly busts the cache -- sanitized and raw are distinct documents', () => {
    expect(recapCacheKey({ ...base, customerFriendly: true })).not.toBe(recapCacheKey(base))
  })

  it('audience remains part of the key (human vs agent do not collide)', () => {
    expect(recapCacheKey({ ...base, audience: 'agent' })).not.toBe(recapCacheKey(base))
  })

  it('period + signals still differentiate', () => {
    expect(recapCacheKey({ ...base, periodEnd: 3000 })).not.toBe(recapCacheKey(base))
    expect(recapCacheKey({ ...base, signals: ['commits'] as RecapSignal[] })).not.toBe(recapCacheKey(base))
  })

  it('a different template busts the cache -- a different deliverable shape', () => {
    expect(recapCacheKey({ ...base, template: 'shipped-report' })).not.toBe(recapCacheKey(base))
  })

  it('a different option toggle busts the cache', () => {
    expect(recapCacheKey({ ...base, options: { terse: true } })).not.toBe(recapCacheKey(base))
    // false vs true for the SAME option are distinct documents.
    expect(recapCacheKey({ ...base, options: { terse: true } })).not.toBe(
      recapCacheKey({ ...base, options: { terse: false } }),
    )
  })

  it('option-key insertion order does not matter (key-sorted serialization)', () => {
    const a = recapCacheKey({ ...base, options: { group_by_project: true, include_cost: false } })
    const b = recapCacheKey({ ...base, options: { include_cost: false, group_by_project: true } })
    expect(a).toBe(b)
  })

  it('an empty options map keys identically to the same recipe (stable default path)', () => {
    expect(recapCacheKey({ ...base, options: {} })).toBe(recapCacheKey(base))
  })
})
