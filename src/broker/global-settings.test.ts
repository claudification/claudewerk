import { afterAll, describe, expect, it } from 'bun:test'
import { getGlobalSettings, initGlobalSettings, updateGlobalSettings } from './global-settings'
import type { KVStore } from './store/types'

/** Map-backed KVStore for driving initGlobalSettings without a real store. */
function fakeKv(initial?: Record<string, unknown>): KVStore {
  const map = new Map<string, unknown>()
  if (initial) map.set('global-settings', initial)
  return {
    get: <T = unknown>(key: string): T | null => (map.has(key) ? (map.get(key) as T) : null),
    set: <T = unknown>(key: string, value: T): void => {
      map.set(key, value)
    },
    delete: (key: string): boolean => map.delete(key),
    keys: (prefix?: string): string[] => [...map.keys()].filter(k => !prefix || k.startsWith(prefix)),
  }
}

// The module holds a singleton; restore pristine defaults so later test files
// do not inherit this file's mutations.
afterAll(() => initGlobalSettings(fakeKv({})))

describe('global-settings defaultTransport (transport reframe)', () => {
  it('schema default: defaultTransport.claude is claude-daemon (Phase 8 cutover)', () => {
    initGlobalSettings(fakeKv())
    expect(getGlobalSettings().defaultTransport.claude).toBe('claude-daemon')
  })

  it('within-object default fills claude when defaultTransport is set without it', () => {
    initGlobalSettings(fakeKv({ defaultTransport: {} }))
    expect(getGlobalSettings().defaultTransport.claude).toBe('claude-daemon')
  })

  it('honors a stored defaultTransport.claude value (overrides the daemon default)', () => {
    initGlobalSettings(fakeKv({ defaultTransport: { claude: 'claude-pty' } }))
    expect(getGlobalSettings().defaultTransport.claude).toBe('claude-pty')
  })

  it('parses a pre-Phase-6 blob carrying the removed defaultBackend (zod strips it, falls back to the default)', () => {
    // Phase 3 migrated live blobs to `defaultTransport`; Phase 6 dropped the
    // `defaultBackend` enum + the migrate-on-read. A blob that ONLY has the
    // removed field parses cleanly (key stripped) to the schema default.
    initGlobalSettings(fakeKv({ defaultBackend: 'daemon' }))
    const s = getGlobalSettings()
    expect(s.defaultTransport.claude).toBe('claude-daemon')
    expect('defaultBackend' in s).toBe(false)
  })

  it('updateGlobalSettings persists a new defaultTransport value (overriding the daemon default)', () => {
    initGlobalSettings(fakeKv())
    const { settings } = updateGlobalSettings({ defaultTransport: { claude: 'claude-pty' } })
    expect(settings.defaultTransport.claude).toBe('claude-pty')
  })
})
