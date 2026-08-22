import { describe, expect, test } from 'bun:test'
import { SCANNER_SKIPS } from '../../shared/scanner-buckets'
import { SCANNER_CONTRACTS } from '../../shared/scanner-contracts'
import { SCANNER_IDS } from '../../shared/scanner-ids'
import { epicScanner } from './epic-scanner'
import { nightshiftScanner } from './nightshift-scanner'
import { refineScanner } from './refine-scanner'
import type { Scanner, ScannerDeps } from './scanner'
import { workOrderScanner } from './work-order-scanner'

/**
 * THE ANTI-DRIFT GUARD between the engine and the checkbox.
 *
 * The opt-in panel renders `SCANNER_CONTRACTS` and the broker runs these
 * records. If a scan's selection or refusal vocabulary ever changed without the
 * contract changing with it, the panel would describe a scanner that no longer
 * exists -- which for a default-deny opt-in is worse than saying nothing.
 */

/** Only the DECLARATION half of a `Scanner`. Structural on purpose: the four
 *  scanners have four different deps types, and widening to `Scanner<any, ...>`
 *  to hold them in one array would be a cast this test does not need. */
type ScannerDeclaration = Pick<Scanner<ScannerDeps, string>, 'id' | 'selects' | 'does' | 'buckets'>

const IMPLEMENTED: readonly ScannerDeclaration[] = [refineScanner, nightshiftScanner, workOrderScanner, epicScanner]

describe('every scanner record quotes its shared contract', () => {
  for (const scanner of IMPLEMENTED) {
    test(`${scanner.id}: selection, verb and refusal vocabulary`, () => {
      const contract = SCANNER_CONTRACTS[scanner.id]
      expect(contract.selects).toBe(scanner.selects)
      expect(contract.does).toBe(scanner.does)
      expect(contract.skips.map(s => s.bucket).sort()).toEqual([...scanner.buckets].sort())
    })

    test(`${scanner.id}: the contract says it is built`, () => {
      expect(SCANNER_CONTRACTS[scanner.id].built).toBe(true)
    })
  }

  test('a scanner with no implementation declares no refusal vocabulary', () => {
    const unimplemented = SCANNER_IDS.filter(id => !IMPLEMENTED.some(s => s.id === id))
    expect(unimplemented).toEqual(['morning-report'])
    for (const id of unimplemented) {
      expect(SCANNER_CONTRACTS[id].built).toBe(false)
      expect(SCANNER_CONTRACTS[id].skips).toEqual([])
    }
  })

  test('every bucket a scanner can file into carries a reason a human can read', () => {
    for (const id of SCANNER_IDS) {
      for (const skip of SCANNER_SKIPS[id]) {
        expect(skip.why.length, `${id}/${skip.bucket}`).toBeGreaterThan(0)
      }
    }
  })
})
