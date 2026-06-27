/**
 * Tier-1 unit tests for `config-patch` -- the sentinel-side application of a
 * broker-pushed `sentinel_patch_config` (Phase 8, plan-sentinel-profiles.md).
 *
 * Covers: validation (unknown profile, bad weight / pool / selection / pool
 * existence), in-place apply + rollback, raw-config splice (unknown-key
 * preservation), and atomic file write round-trip.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SentinelPatchConfig } from '../shared/protocol'
import {
  applyPatchInPlace,
  atomicWriteRawConfig,
  readRawConfigObject,
  spliceRawConfig,
  validatePatch,
} from './config-patch'
import { loadSentinelConfig, type SentinelConfig } from './sentinel-config'

let scratch = ''
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'patch-test-'))
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Build a config from a written JSON file so we exercise the real loader. */
function configFrom(raw: Record<string, unknown>): { config: SentinelConfig; path: string } {
  const path = join(scratch, 'sentinel.json')
  writeFileSync(path, JSON.stringify(raw, null, 2))
  return { config: loadSentinelConfig({ configPath: path, home: scratch }), path }
}

function patch(p: Partial<SentinelPatchConfig>): SentinelPatchConfig {
  return { type: 'sentinel_patch_config', patchId: 'p1', ...p }
}

describe('validatePatch', () => {
  test('accepts a valid per-profile + sentinel-wide patch', () => {
    const { config } = configFrom({
      profiles: {
        work: { configDir: '~/.claude-work', pool: 'main' },
        alt: { configDir: '~/.claude-alt', pool: 'main' },
      },
    })
    const res = validatePatch(
      config,
      patch({
        profiles: { work: { weight: 3, label: 'Work', color: '#abc' }, alt: { pool: 'main' } },
        defaultSelection: 'balanced',
        defaultPool: 'main',
      }),
    )
    expect(res.ok).toBe(true)
  })

  test('rejects an unknown profile name', () => {
    const { config } = configFrom({ profiles: { work: { configDir: '~/.claude-work' } } })
    const res = validatePatch(config, patch({ profiles: { ghost: { weight: 1 } } }))
    expect(res).toMatchObject({ ok: false, error: 'unknown_profile' })
  })

  test('rejects a negative weight', () => {
    const { config } = configFrom({ profiles: { work: { configDir: '~/.claude-work' } } })
    const res = validatePatch(config, patch({ profiles: { work: { weight: -1 } } }))
    expect(res).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  test('rejects a malformed pool name but accepts null (excluded)', () => {
    const { config } = configFrom({ profiles: { work: { configDir: '~/.claude-work' } } })
    expect(validatePatch(config, patch({ profiles: { work: { pool: 'BAD POOL' } } }))).toMatchObject({
      ok: false,
      error: 'invalid_value',
    })
    expect(validatePatch(config, patch({ profiles: { work: { pool: null } } })).ok).toBe(true)
  })

  test('rejects a bad defaultSelection', () => {
    const { config } = configFrom({ profiles: { work: { configDir: '~/.claude-work' } } })
    const res = validatePatch(config, patch({ defaultSelection: 'nonsense' as never }))
    expect(res).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  test('rejects a defaultPool that names no post-patch pool', () => {
    const { config } = configFrom({ profiles: { work: { configDir: '~/.claude-work', pool: 'main' } } })
    const res = validatePatch(config, patch({ defaultPool: 'ghost-pool' }))
    expect(res).toMatchObject({ ok: false, error: 'invalid_value' })
  })

  test('accepts a defaultPool that the same patch creates via a profile move', () => {
    const { config } = configFrom({ profiles: { work: { configDir: '~/.claude-work', pool: 'main' } } })
    const res = validatePatch(config, patch({ profiles: { work: { pool: 'fresh' } }, defaultPool: 'fresh' }))
    expect(res.ok).toBe(true)
  })
})

describe('applyPatchInPlace', () => {
  test('mutates only the patched fields and reports touched diffs', () => {
    const { config } = configFrom({
      profiles: { work: { configDir: '~/.claude-work', pool: 'main', weight: 1, label: 'Old' } },
    })
    const touched = applyPatchInPlace(
      config,
      patch({ profiles: { work: { weight: 5, label: 'New', pool: 'alt' } }, defaultSelection: 'random' }),
    )
    expect(config.profiles.work.weight).toBe(5)
    expect(config.profiles.work.label).toBe('New')
    expect(config.profiles.work.pool).toBe('alt')
    expect(config.defaultSelection).toBe('random')
    // default profile (synthesised) untouched.
    expect(config.profiles.default.weight).toBe(1)
    const fields = touched.map(t => `${t.scope}.${t.field}`)
    expect(fields).toContain('work.weight')
    expect(fields).toContain('sentinel.defaultSelection')
  })

  test('empty-string label/color clears the field', () => {
    const { config } = configFrom({
      profiles: { work: { configDir: '~/.claude-work', label: 'X', color: '#fff' } },
    })
    applyPatchInPlace(config, patch({ profiles: { work: { label: '', color: '' } } }))
    expect(config.profiles.work.label).toBeUndefined()
    expect(config.profiles.work.color).toBeUndefined()
  })
})

describe('spliceRawConfig -- unknown-key preservation', () => {
  test('preserves configDir / env / spawnRoot / future keys + top-level extras', () => {
    const raw = {
      schemaVersion: 9, // future top-level key
      defaultSelection: 'default',
      profiles: {
        work: {
          configDir: '/home/u/.claude-work',
          env: { ANTHROPIC_API_KEY: 'secret' },
          spawnRoot: '/repos',
          futureField: true,
          weight: 1,
          pool: 'main',
        },
      },
    }
    const next = spliceRawConfig(raw, patch({ profiles: { work: { weight: 4, label: 'Work' } } }))
    const work = (next.profiles as Record<string, Record<string, unknown>>).work
    // Secret-bearing + future fields survive untouched.
    expect(work.configDir).toBe('/home/u/.claude-work')
    expect(work.env).toEqual({ ANTHROPIC_API_KEY: 'secret' })
    expect(work.spawnRoot).toBe('/repos')
    expect(work.futureField).toBe(true)
    expect(work.pool).toBe('main')
    // Top-level future key survives.
    expect(next.schemaVersion).toBe(9)
    // Patched fields applied.
    expect(work.weight).toBe(4)
    expect(work.label).toBe('Work')
  })

  test('does not mutate the input object', () => {
    const raw = { profiles: { work: { configDir: '/x', weight: 1 } } }
    const before = JSON.stringify(raw)
    spliceRawConfig(raw, patch({ profiles: { work: { weight: 9 } } }))
    expect(JSON.stringify(raw)).toBe(before)
  })

  test('splices sentinel-wide fields', () => {
    const next = spliceRawConfig({ profiles: {} }, patch({ defaultSelection: 'balanced', defaultPool: 'main' }))
    expect(next.defaultSelection).toBe('balanced')
    expect(next.defaultPool).toBe('main')
  })
})

describe('atomicWriteRawConfig + readRawConfigObject round-trip', () => {
  test('writes then reads back identical object', () => {
    const path = join(scratch, 'rt.json')
    const obj = { defaultSelection: 'random', profiles: { a: { configDir: '/a', weight: 2 } } }
    atomicWriteRawConfig(path, obj)
    expect(readRawConfigObject(path)).toEqual(obj)
  })

  test('readRawConfigObject tolerates a missing file (returns {})', () => {
    expect(readRawConfigObject(join(scratch, 'nope.json'))).toEqual({})
  })

  test('readRawConfigObject throws on malformed JSON', () => {
    const path = join(scratch, 'bad.json')
    writeFileSync(path, '{ not json')
    expect(() => readRawConfigObject(path)).toThrow()
  })

  test('end-to-end: validate -> apply -> splice -> write -> reload reflects the patch', () => {
    const { config, path } = configFrom({
      profiles: { work: { configDir: '~/.claude-work', pool: 'main', weight: 1 } },
    })
    const p = patch({ profiles: { work: { weight: 7 } }, defaultSelection: 'random' })
    expect(validatePatch(config, p).ok).toBe(true)
    applyPatchInPlace(config, p)
    const next = spliceRawConfig(readRawConfigObject(path), p)
    atomicWriteRawConfig(path, next)
    const reloaded = loadSentinelConfig({ configPath: path, home: scratch })
    expect(reloaded.profiles.work.weight).toBe(7)
    expect(reloaded.defaultSelection).toBe('random')
    // configDir untouched by the patch.
    expect(reloaded.profiles.work.configDir).toBe(join(scratch, '.claude-work'))
  })
})
