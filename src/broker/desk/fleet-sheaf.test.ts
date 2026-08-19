/**
 * The rollup's own behaviour is tested where it now lives:
 * `src/shared/sheaf-summary.test.ts`. What is left here is the seam -- the desk
 * (and `awareness-tools.ts` through it) still imports `summarizeSheaf` from this
 * module, and `scripts/wall-verify` probes this file for that symbol. A silent
 * drop of the re-export would break both without touching a single test that
 * mentions the desk.
 */

import { describe, expect, test } from 'bun:test'
import type { SheafResponse } from '../../shared/sheaf-types'
import { getFleetSheafProvider, summarizeSheaf } from './fleet-sheaf'

const EMPTY: SheafResponse = {
  windowH: 6,
  windowStart: 0,
  windowEnd: 1,
  generatedAt: 1,
  totals: {
    projects: 0,
    conversations: 0,
    trees: 0,
    tokens: { input: 0, output: 0, cache: 0 },
    cost: { amount: 0, estimated: false },
  },
  projects: [],
}

describe('fleet-sheaf', () => {
  test('re-exports the shared rollup the desk and the wall both call', () => {
    expect(summarizeSheaf(EMPTY)).toMatchObject({ windowH: 6, projects: [] })
  })

  // Deliberately NOT binding a provider here: it is a module singleton shared
  // with `awareness-tools.test.ts`, whose "degrades when unbound" case would
  // start passing for the wrong reason.
  test('exposes the provider seam the broker boot binds', () => {
    expect(typeof getFleetSheafProvider).toBe('function')
  })
})
