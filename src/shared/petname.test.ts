/**
 * Tier 1 unit tests for the petname generator (plan-quest-engine §4). A petname
 * must be slug-safe, syntactically valid, and ALWAYS collision-free against the
 * `taken` predicate -- a busy project must never wedge quest creation.
 */
import { describe, expect, test } from 'bun:test'
import { generatePetname, isValidPetname, randomPetname } from './petname'

describe('petname shape', () => {
  test('randomPetname is a valid adjective-animal slug', () => {
    for (let i = 0; i < 200; i++) {
      const name = randomPetname()
      expect(isValidPetname(name)).toBe(true)
      expect(name).toMatch(/^[a-z]+-[a-z]+$/)
    }
  })

  test('isValidPetname rejects traversal + junk', () => {
    expect(isValidPetname('floppy-panda')).toBe(true)
    expect(isValidPetname('floppy-panda-2')).toBe(true)
    expect(isValidPetname('../etc')).toBe(false)
    expect(isValidPetname('Floppy-Panda')).toBe(false)
    expect(isValidPetname('floppy')).toBe(false)
    expect(isValidPetname('')).toBe(false)
    expect(isValidPetname('a/b')).toBe(false)
  })
})

describe('collision handling', () => {
  test('never returns a taken name', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const name = generatePetname(n => taken.has(n))
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
    expect(taken.size).toBe(500)
  })

  test('falls back to a numeric suffix when the base keyspace is exhausted', () => {
    // Everything without a numeric suffix is "taken" -> forces the suffix path.
    const name = generatePetname(n => !/-[0-9]+$/.test(n), 8)
    expect(isValidPetname(name)).toBe(true)
    expect(name).toMatch(/-[0-9]+$/)
  })
})
