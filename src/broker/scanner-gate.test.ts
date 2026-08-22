/**
 * THE CALLER-SIDE OPT-IN: the factory, the change-detecting skip log, and the
 * narrowing the two make together.
 *
 * The default is the whole point. `scanner-opt-in.ts` says in its own header that
 * one function exists so there is no second spelling of "off" to get wrong; this
 * file is the store-backed spelling, and every case below is a way it could
 * quietly say yes.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { getProjectSettings, initProjectSettings, setProjectSettings } from './project-settings'
import { buildScannerOptIn, buildSkipLog, gateProjects, type ScannerOptIn } from './scanner-gate'
import type { KVStore } from './store/types'

/**
 * URIs NOBODY ELSE IN THE SUITE USES, and assertions that never demand the
 * settings map hold ONLY them.
 *
 * `initProjectSettings` does not clear the module-level map when the KV it is
 * handed is empty -- it early-returns on a missing blob -- so a fresh store per
 * case still inherits every project a previously-linked test file configured, in
 * one shared `bun test` process. An exact-equality assertion on `projects()`
 * would therefore pass or fail on FILE ORDER, which is a red run nobody can
 * reproduce. Membership is the honest question here anyway: the claim is that
 * this project is in the list and that one is not.
 */
const A = 'claude://default/tmp/scanner-gate-test/alpha'
const B = 'claude://default/tmp/scanner-gate-test/beta'

function memoryKv(): KVStore {
  const map = new Map<string, unknown>()
  return {
    get: <T>(key: string) => (map.get(key) as T) ?? null,
    set: (key, value) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  }
}

beforeEach(() => {
  initProjectSettings(memoryKv())
  // A fresh KV leaves the module map from the previous case in place -- the same
  // reason `project-settings.scanners.test.ts` wipes by hand.
  for (const project of [A, B]) {
    setProjectSettings(project, { scanners: undefined, scannersLastRun: undefined, label: undefined })
  }
})

describe('buildScannerOptIn', () => {
  test('a project that never ticked the box is off, and is not in `projects`', () => {
    const optIn = buildScannerOptIn('refine')
    expect(optIn.enabled(A)).toBe(false)
    expect(optIn.projects()).not.toContain(A)
  })

  test('ticking one box turns on exactly that scanner, for exactly that project', () => {
    setProjectSettings(A, { scanners: { refine: true } })
    const refine = buildScannerOptIn('refine')
    const workOrder = buildScannerOptIn('work-order')
    expect(refine.enabled(A)).toBe(true)
    expect(refine.enabled(B)).toBe(false)
    expect(workOrder.enabled(A)).toBe(false)
    expect(refine.projects()).toContain(A)
    expect(refine.projects()).not.toContain(B)
    expect(workOrder.projects()).not.toContain(A)
  })

  test('reads the store LIVE, so a box ticked after boot takes effect on the next tick', () => {
    const optIn = buildScannerOptIn('refine')
    expect(optIn.enabled(A)).toBe(false)
    setProjectSettings(A, { scanners: { refine: true } })
    expect(optIn.enabled(A)).toBe(true)
  })

  test('`enabled` normalizes the project it is handed; `projects` reports canonical keys', () => {
    setProjectSettings(A, { scanners: { 'work-order': true } })
    const optIn = buildScannerOptIn('work-order')
    expect(optIn.enabled('claude://work@default/tmp/scanner-gate-test/alpha')).toBe(true)
    expect(optIn.projects()).toContain(A)
  })

  test('the persisted plural spelling still counts as the box being ticked', () => {
    // Every project that ticked the box before the singular rename has
    // `work-orders` on disk, and a read that missed it would silently switch the
    // scanner OFF for exactly them -- indistinguishable from never enabled.
    setProjectSettings(A, { scanners: { 'work-orders': true } as Record<string, boolean> })
    expect(buildScannerOptIn('work-order').enabled(A)).toBe(true)
  })

  test('`stamp` lands under the id the gate was built for, and only that one', () => {
    setProjectSettings(A, { scanners: { refine: true, 'work-order': true } })
    buildScannerOptIn('refine').stamp(A, 111)
    buildScannerOptIn('work-order').stamp(A, 222)
    expect(getProjectSettings(A)?.scannersLastRun).toEqual({ refine: 111, 'work-order': 222 })
  })
})

/** An opt-in with a fixed answer, for the cases that are about the narrowing
 *  rather than about the store. */
function fakeOptIn(on: readonly string[]): ScannerOptIn {
  return { projects: () => [...on], enabled: p => on.includes(p), stamp: () => {} }
}

describe('buildSkipLog', () => {
  test('names the scanner, the count, every project, and which box to tick', () => {
    const lines: string[] = []
    buildSkipLog('refine', l => lines.push(l)).note([B, A])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[scanner:refine]')
    expect(lines[0]).toContain('skipped 2 project(s)')
    expect(lines[0]).toContain(A)
    expect(lines[0]).toContain(B)
    expect(lines[0]).toContain('Project Settings > Scanners')
  })

  test('an unchanged skip set is logged ONCE, not once a minute forever', () => {
    const lines: string[] = []
    const log = buildSkipLog('refine', l => lines.push(l))
    log.note([A, B])
    log.note([A, B])
    // Same set, different order -- still the same news.
    log.note([B, A])
    expect(lines).toHaveLength(1)
  })

  test('a change in the set IS news and is logged again', () => {
    const lines: string[] = []
    const log = buildSkipLog('refine', l => lines.push(l))
    log.note([A, B])
    log.note([A])
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('skipped 1 project(s)')
  })

  test('going from "some skipped" to "none skipped" is said out loud', () => {
    const lines: string[] = []
    const log = buildSkipLog('work-order', l => lines.push(l))
    log.note([A])
    log.note([])
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('every known project')
  })

  test('a first call with nothing skipped stays silent -- there is no news in it', () => {
    const lines: string[] = []
    buildSkipLog('work-order', l => lines.push(l)).note([])
    expect(lines).toEqual([])
  })
})

describe('gateProjects', () => {
  test('runs only what opted in, and reports the rest', () => {
    const lines: string[] = []
    const out = gateProjects(
      [A, B],
      fakeOptIn([A]),
      buildSkipLog('refine', l => lines.push(l)),
    )
    expect(out.run).toEqual([A])
    expect(out.skipped).toEqual([B])
    expect(lines[0]).toContain(B)
  })

  test('an enabled project the registry has never heard of is still swept', () => {
    // Settings outlive a registry row, and its stamp is the only thing that
    // would ever say the loop is alive for it.
    const out = gateProjects(
      [],
      fakeOptIn([A]),
      buildSkipLog('refine', () => {}),
    )
    expect(out.run).toEqual([A])
  })

  test('with nothing opted in, nothing runs and every known project is named once', () => {
    const lines: string[] = []
    const log = buildSkipLog('refine', l => lines.push(l))
    expect(gateProjects([A, B], fakeOptIn([]), log).run).toEqual([])
    expect(gateProjects([A, B], fakeOptIn([]), log).run).toEqual([])
    expect(lines).toHaveLength(1)
  })
})
