/**
 * The registry is one array and one filter, so these are mostly PINS on the two
 * decisions that are easy to reverse by accident: unknown means missing, and a
 * token is never dropped once shipped.
 */

import { describe, expect, test } from 'bun:test'
import { SYSTEM_TAGS } from './board-system-tags'
import { DEPLOYED_CAPABILITIES, missingCapabilities } from './deployed-capabilities'

describe('missingCapabilities', () => {
  test('a card that asks for nothing is satisfied by every build', () => {
    expect(missingCapabilities(undefined)).toEqual([])
    expect(missingCapabilities([])).toEqual([])
  })

  test('a token this build provides is satisfied', () => {
    expect(missingCapabilities(['needs-werk-master-tag'])).toEqual([])
  })

  test('FAILS CLOSED: a token nothing has ever provided reads as missing', () => {
    // The load-bearing behaviour. A build reading a card from a future it has
    // never heard of must withhold, not shrug -- the opposite default makes the
    // key decorative on exactly the deploys it exists for.
    expect(missingCapabilities(['invented-next-year'])).toEqual(['invented-next-year'])
  })

  test('reports the missing tokens IN THE CARD ORDER, not the registry order', () => {
    expect(missingCapabilities(['zeta', 'needs-werk-master-tag', 'alpha'])).toEqual(['zeta', 'alpha'])
  })

  test('an explicit provided-set overrides this build, for a caller that knows more', () => {
    expect(missingCapabilities(['needs-werk-master-tag'], new Set())).toEqual(['needs-werk-master-tag'])
    expect(missingCapabilities(['anything'], new Set(['anything']))).toEqual([])
  })
})

describe('the registry itself', () => {
  test('APPEND-ONLY: the tokens shipped so far are still all here', () => {
    // Removing one turns every card naming it from dispatchable into
    // permanently withheld, on boards this repo does not own.
    expect([...DEPLOYED_CAPABILITIES]).toEqual(['needs-werk-master-tag'])
  })

  test('no token is declared twice', () => {
    expect(new Set(DEPLOYED_CAPABILITIES).size).toBe(DEPLOYED_CAPABILITIES.length)
  })

  test('the seat-rename token still names a tag the engine actually folds over', () => {
    // The token is a claim about THIS build. If the word it is named for ever
    // leaves the system-tag registry, the claim has quietly become false.
    expect(SYSTEM_TAGS.map(t => t.tag)).toContain('needs-werk-master')
  })
})
