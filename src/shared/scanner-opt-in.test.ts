import { describe, expect, test } from 'bun:test'
import { canonicalScannerId, isScannerWord, SCANNER_IDS } from './scanner-ids'
import {
  canonicalizeScannerToggles,
  packScannerToggles,
  type ScannerToggles,
  scannerEnabled,
  scannerLastRun,
} from './scanner-opt-in'

describe('scannerEnabled -- off by default, every scanner, every project', () => {
  test('a project with no settings at all has every scanner off', () => {
    for (const id of SCANNER_IDS) {
      expect(scannerEnabled(null, id)).toBe(false)
      expect(scannerEnabled(undefined, id)).toBe(false)
    }
  })

  test('a configured project that never mentioned scanners has every scanner off', () => {
    for (const id of SCANNER_IDS) expect(scannerEnabled({}, id)).toBe(false)
  })

  test('an empty toggles map has every scanner off', () => {
    for (const id of SCANNER_IDS) expect(scannerEnabled({ scanners: {} }, id)).toBe(false)
  })

  test('only the id that was ticked is on', () => {
    const settings = { scanners: { epics: true } }
    expect(scannerEnabled(settings, 'epics')).toBe(true)
    for (const id of SCANNER_IDS.filter(i => i !== 'epics')) expect(scannerEnabled(settings, id)).toBe(false)
  })

  test('an explicit false is off, not truthy-by-presence', () => {
    expect(scannerEnabled({ scanners: { epics: false } }, 'epics')).toBe(false)
  })

  test('anything that is not exactly true is off', () => {
    // The shape a hand-edited store or an older payload could produce. `=== true`
    // is what stops `1` or `'yes'` from arming an unattended agent.
    const bent = { scanners: { epics: 1 } } as unknown as { scanners: Record<string, boolean> }
    expect(scannerEnabled(bent, 'epics')).toBe(false)
  })
})

describe('scannerLastRun', () => {
  test('never run reads undefined, not 0 -- 0 is a timestamp', () => {
    expect(scannerLastRun({ scanners: { epics: true } }, 'epics')).toBeUndefined()
    expect(scannerLastRun(null, 'epics')).toBeUndefined()
  })

  test('reads back the stamp for that scanner only', () => {
    const settings = { scannersLastRun: { epics: 1234 } }
    expect(scannerLastRun(settings, 'epics')).toBe(1234)
    expect(scannerLastRun(settings, 'refine')).toBeUndefined()
  })
})

describe('packScannerToggles', () => {
  test('all-off packs to undefined, so the key is stripped rather than stored', () => {
    expect(packScannerToggles({})).toBeUndefined()
    expect(packScannerToggles({ epics: false, refine: false })).toBeUndefined()
  })

  test('keeps only the true entries', () => {
    expect(packScannerToggles({ epics: true, refine: false })).toEqual({ epics: true })
  })

  test('a packed map round-trips through the predicate', () => {
    const packed = packScannerToggles({ epics: true, nightshift: false })
    expect(scannerEnabled({ scanners: packed }, 'epics')).toBe(true)
    expect(scannerEnabled({ scanners: packed }, 'nightshift')).toBe(false)
  })
})

/**
 * THE ALIAS -- singular is the id, the plural spelling still reads.
 *
 * `work-orders` was the id until the singular rename, and it is on disk in every
 * project that ticked that box before it. A read that missed the old spelling
 * would switch the scanner silently OFF for exactly those projects, and a
 * default-deny opt-in cannot tell that apart from "never enabled" -- so the
 * failure would be invisible on every surface.
 */
describe('a renamed scanner id reads under its old spelling', () => {
  /** Typed as the stored shape, which is what makes the cast honest: the map on
   *  disk predates the union, so its keys are not `ScannerId` at runtime. */
  const stored = (map: Record<string, boolean>): { scanners: ScannerToggles } => ({ scanners: map as ScannerToggles })

  test('the singular is the id and the plural is not', () => {
    expect(SCANNER_IDS).toContain('work-order')
    expect(SCANNER_IDS).not.toContain('work-orders' as never)
    expect(canonicalScannerId('work-orders')).toBe('work-order')
    expect(canonicalScannerId('work-order')).toBe('work-order')
  })

  test('a word that is no scanner in any spelling is not one', () => {
    expect(canonicalScannerId('werk')).toBeUndefined()
    expect(isScannerWord('werk')).toBe(false)
    expect(isScannerWord('work-orders')).toBe(true)
  })

  test('a project that ticked the box under the old name still has it on', () => {
    expect(scannerEnabled(stored({ 'work-orders': true }), 'work-order')).toBe(true)
  })

  test('and its last-run stamp is found too', () => {
    const settings = { scannersLastRun: { 'work-orders': 1234 } as ScannerToggles & Record<string, number> }
    expect(scannerLastRun(settings as never, 'work-order')).toBe(1234)
  })

  test('the CANONICAL key wins when both are present -- an alias may not re-arm it', () => {
    expect(scannerEnabled(stored({ 'work-orders': true, 'work-order': false }), 'work-order')).toBe(false)
    expect(scannerEnabled(stored({ 'work-orders': false, 'work-order': true }), 'work-order')).toBe(true)
  })

  test('an alias does not leak onto a DIFFERENT scanner', () => {
    const settings = stored({ 'work-orders': true })
    for (const id of SCANNER_IDS.filter(i => i !== 'work-order')) expect(scannerEnabled(settings, id)).toBe(false)
  })

  test('saving rewrites the alias to the canonical id -- this is how it drains', () => {
    expect(packScannerToggles({ 'work-orders': true } as ScannerToggles)).toEqual({ 'work-order': true })
  })

  test('canonicalising drops a key that is not a scanner at all', () => {
    expect(canonicalizeScannerToggles({ werk: true } as ScannerToggles)).toEqual({})
    expect(canonicalizeScannerToggles(undefined)).toEqual({})
  })

  /**
   * THE BUG CANONICALISING-ON-LOAD EXISTS TO PREVENT. Form state that keeps the
   * alias key writes `{'work-orders': true, 'work-order': false}` on an untick;
   * the pack drops the false, the alias survives, and the box does not work for
   * precisely the projects the alias serves.
   */
  test('unticking a box loaded under the old spelling actually turns it off', () => {
    const loaded = canonicalizeScannerToggles({ 'work-orders': true } as ScannerToggles)
    const afterUntick = { ...loaded, 'work-order': false }
    const saved = packScannerToggles(afterUntick)
    expect(saved).toBeUndefined()
    expect(scannerEnabled({ scanners: saved }, 'work-order')).toBe(false)
  })
})
