/**
 * Regression: the blank-save that wiped Jonas's canvases. See pre-seed-blank.ts
 * for the full sequence.
 */

import { describe, expect, test } from 'vitest'
import { isPreSeedBlank } from './pre-seed-blank'

describe('isPreSeedBlank', () => {
  test('an empty scene while the DSL seed is in flight is NOT an edit', () => {
    expect(isPreSeedBlank({ dslSeedPending: true, elementCount: 0 })).toBe(true)
  })

  test('an empty scene AFTER the seed landed is a real clear -- it must save', () => {
    expect(isPreSeedBlank({ dslSeedPending: false, elementCount: 0 })).toBe(false)
  })

  test('a non-empty scene is always a real edit, seed pending or not', () => {
    expect(isPreSeedBlank({ dslSeedPending: true, elementCount: 3 })).toBe(false)
    expect(isPreSeedBlank({ dslSeedPending: false, elementCount: 3 })).toBe(false)
  })
})
