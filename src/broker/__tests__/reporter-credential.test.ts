/**
 * Card `node-stats-reporter-credential`:
 *   scope 1  -- `rpt_` secrets in the same registry, kind 'reporter'
 *   done 4   -- A reporter NEVER appears as a spawn target
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSentinelRegistry,
  isReporterRecord,
  isReporterSecret,
  isSentinelSecret,
  recordKind,
  type SentinelRegistry,
} from '../sentinel-registry'

const TEST_CACHE_DIR = join(import.meta.dirname, '.test-reporter-credential')

let registry: SentinelRegistry

beforeEach(() => {
  mkdirSync(TEST_CACHE_DIR, { recursive: true })
  registry = createSentinelRegistry(TEST_CACHE_DIR)
})

afterEach(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
})

describe('rpt_ keys live in the SAME registry', () => {
  it('creates an rpt_-prefixed secret with kind reporter', () => {
    const record = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    expect(record.rawSecret?.startsWith('rpt_')).toBe(true)
    expect(record.kind).toBe('reporter')
    expect(isReporterSecret(record.rawSecret ?? '')).toBe(true)
    expect(isSentinelSecret(record.rawSecret ?? '')).toBe(false)
  })

  it('a sentinel still gets an snt_ secret', () => {
    const record = registry.create({ alias: 'studio', generateSecret: true })
    expect(record.rawSecret?.startsWith('snt_')).toBe(true)
    expect(recordKind(record)).toBe('sentinel')
  })

  it('both kinds share one registry FILE', () => {
    registry.create({ alias: 'studio', generateSecret: true })
    registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    const raw = JSON.parse(readFileSync(join(TEST_CACHE_DIR, 'sentinel-registry.json'), 'utf8'))
    expect(Object.keys(raw.sentinels).length).toBe(2)
  })

  it('a legacy record with no `kind` is a SENTINEL, not a reporter', () => {
    const record = registry.create({ alias: 'legacy', generateSecret: true })
    expect(record.kind).toBeUndefined()
    expect(isReporterRecord(record)).toBe(false)
    expect(registry.getAll().size).toBe(1)
  })

  it('findBySecret is the ONE lookup that spans both kinds (auth needs it)', () => {
    const rpt = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    const found = registry.findBySecret(rpt.rawSecret ?? '')
    expect(found?.sentinelId).toBe(rpt.sentinelId)
    expect(isReporterRecord(found ?? { aliases: [], isDefault: false, createdAt: 0 })).toBe(true)
  })

  it('revoking a reporter invalidates its secret', () => {
    const rpt = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    registry.remove(rpt.sentinelId)
    expect(registry.findBySecret(rpt.rawSecret ?? '')).toBeUndefined()
  })
})

describe('a reporter NEVER appears as a spawn target', () => {
  it('is absent from getAll() -- the roster every launch surface reads', () => {
    registry.create({ alias: 'studio', generateSecret: true })
    registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    const roster = [...registry.getAll().values()].map(r => r.aliases[0])
    expect(roster).toEqual(['studio'])
  })

  it('is unreachable by findByAlias(), so no spawn can resolve to it', () => {
    registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    expect(registry.findByAlias('beast')).toBeUndefined()
    expect(registry.findReporterByAlias('beast')).toBeDefined()
    expect(registry.findAnyByAlias('beast')).toBeDefined() // uniqueness checks still see it
  })

  it('is never the default sentinel, even as the FIRST record in an empty registry', () => {
    const rpt = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    expect(rpt.isDefault).toBe(false)
    expect(registry.getDefault()).toBeUndefined()
    expect(registry.getDefaultId()).toBeUndefined()
  })

  it('refuses setDefault()', () => {
    const rpt = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    expect(registry.setDefault(rpt.sentinelId)).toBe(false)
    expect(registry.getDefault()).toBeUndefined()
  })

  it('refuses promotion to default via update()', () => {
    registry.create({ alias: 'studio', generateSecret: true })
    const rpt = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    registry.update(rpt.sentinelId, { isDefault: true })
    expect(registry.getDefault()?.aliases[0]).toBe('studio')
  })

  it('is never picked up as the replacement default when the real one is removed', () => {
    const studio = registry.create({ alias: 'studio', generateSecret: true })
    registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    registry.remove(studio.sentinelId)
    // One record left in the file -- and it is a reporter, so there is NO default.
    expect(registry.getAllReporters().size).toBe(1)
    expect(registry.getDefault()).toBeUndefined()
    expect(registry.getDefaultId()).toBeUndefined()
  })

  it('survives a reload without leaking into the roster', () => {
    registry.create({ alias: 'studio', generateSecret: true })
    registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' })
    const reloaded = createSentinelRegistry(TEST_CACHE_DIR)
    expect([...reloaded.getAll().values()].map(r => r.aliases[0])).toEqual(['studio'])
    expect(reloaded.getAllReporters().size).toBe(1)
  })
})
