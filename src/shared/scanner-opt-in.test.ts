import { describe, expect, test } from 'bun:test'
import { SCANNER_IDS } from './scanner-ids'
import { packScannerToggles, scannerEnabled, scannerLastRun } from './scanner-opt-in'

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
