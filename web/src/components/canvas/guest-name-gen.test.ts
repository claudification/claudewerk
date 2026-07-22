import { describe, expect, it } from 'vitest'
import { generateGuestName } from './guest-name-gen'

describe('generateGuestName', () => {
  it('produces an "Adjective Animal" handle', () => {
    const name = generateGuestName(() => 0)
    expect(name).toBe('Snarky Whale') // first adjective + first animal at rng=0
  })
  it('is two capitalized words', () => {
    const name = generateGuestName()
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })
})
