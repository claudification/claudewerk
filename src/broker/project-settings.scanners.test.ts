/**
 * The scanner half of the project-settings store: the opt-in read and the
 * last-run stamp.
 *
 * `stampScannerRun` exists at all because `setProjectSettings` merges SHALLOWLY,
 * so the obvious spelling would erase every sibling stamp on every tick. Most of
 * what is below is that one bug, pinned.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { ProjectSettings } from '../shared/protocol'
import {
  getProjectSettings,
  initProjectSettings,
  scannerEnabledForProject,
  setProjectSettings,
  stampScannerRun,
} from './project-settings'
import type { KVStore } from './store/types'

const PROJECT = 'claude://default/Users/jonas/projects/demo'

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
  // A fresh KV leaves the module map from the previous test in place, so wipe
  // the one project each case touches rather than trusting init to clear it.
  setProjectSettings(PROJECT, { scanners: undefined, scannersLastRun: undefined, label: undefined })
})

describe('scannerEnabledForProject', () => {
  test('a project that was never configured has every scanner off', () => {
    expect(scannerEnabledForProject(PROJECT, 'epics')).toBe(false)
  })

  test('ticking the box turns exactly that scanner on', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    expect(scannerEnabledForProject(PROJECT, 'epics')).toBe(true)
    expect(scannerEnabledForProject(PROJECT, 'refine')).toBe(false)
  })

  test('the answer is the same under a non-canonical spelling of the project', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    expect(scannerEnabledForProject('claude://work@default/Users/jonas/projects/demo', 'epics')).toBe(true)
  })

  test('clearing the map with undefined turns everything back off', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    setProjectSettings(PROJECT, { scanners: undefined })
    expect(scannerEnabledForProject(PROJECT, 'epics')).toBe(false)
  })
})

describe('stampScannerRun', () => {
  test('records the stamp for one scanner', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    stampScannerRun(PROJECT, 'epics', 5000)
    expect(getProjectSettings(PROJECT)?.scannersLastRun).toEqual({ epics: 5000 })
  })

  test('a second scanner does NOT erase the first -- the shallow-merge bug', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true, refine: true } })
    stampScannerRun(PROJECT, 'epics', 5000)
    stampScannerRun(PROJECT, 'refine', 6000)
    expect(getProjectSettings(PROJECT)?.scannersLastRun).toEqual({ epics: 5000, refine: 6000 })
  })

  test('a later stamp for the same scanner overwrites its own', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    stampScannerRun(PROJECT, 'epics', 5000)
    stampScannerRun(PROJECT, 'epics', 9000)
    expect(getProjectSettings(PROJECT)?.scannersLastRun).toEqual({ epics: 9000 })
  })

  test('the toggles survive being stamped', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    stampScannerRun(PROJECT, 'epics', 5000)
    expect(scannerEnabledForProject(PROJECT, 'epics')).toBe(true)
  })

  test('an unconfigured project is not conjured into existence by a stamp', () => {
    stampScannerRun('claude://default/never/configured', 'epics', 5000)
    expect(getProjectSettings('claude://default/never/configured')).toBeNull()
  })

  test('a project settings write that does not mention the stamps preserves them', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    stampScannerRun(PROJECT, 'epics', 5000)
    // What the settings editor sends: everything it owns, and no stamps.
    setProjectSettings(PROJECT, { label: 'Demo', scanners: { epics: true } } as ProjectSettings)
    expect(getProjectSettings(PROJECT)?.scannersLastRun).toEqual({ epics: 5000 })
  })
})
