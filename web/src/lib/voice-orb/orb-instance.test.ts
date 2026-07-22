import { describe, expect, it } from 'vitest'
import { getOrbInstanceId, isForThisOrb } from './orb-instance'

describe('orb instance id', () => {
  it('is stable across calls', () => {
    expect(getOrbInstanceId()).toBe(getOrbInstanceId())
  })

  it('is a SHORT speakable id (6 base36 chars), not a UUID', () => {
    expect(getOrbInstanceId()).toMatch(/^[a-z0-9]{6}$/)
  })

  it('accepts broadcast deliveries (null/empty target)', () => {
    expect(isForThisOrb(null)).toBe(true)
    expect(isForThisOrb(undefined)).toBe(true)
    expect(isForThisOrb('')).toBe(true)
  })

  it('accepts a delivery aimed at this instance, rejects others', () => {
    expect(isForThisOrb(getOrbInstanceId())).toBe(true)
    expect(isForThisOrb('some-other-orb')).toBe(false)
  })
})
