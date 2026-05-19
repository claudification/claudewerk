/**
 * Tier 1 unit tests for `selection` -- Fixed / Balanced / Random / default.
 *
 * Selection is sentinel-side. The broker never picks; it sends a literal
 * name or a mode token, and the sentinel resolves. Tests cover:
 *   - Fixed wins over everything (and unknown literal throws).
 *   - Balanced picks least-loaded pooled; ties broken by name; skips
 *     non-pooled; empty pool falls back to default.
 *   - Random picks only from pooled, with a seeded RNG for determinism.
 *   - `defaultSelection` (config) drives no-input spawns.
 */
import { describe, expect, test } from 'bun:test'
import { pickProfile } from './selection'
import type { SentinelConfig } from './sentinel-config'

function mkConfig(
  defaultSelection: SentinelConfig['defaultSelection'],
  profiles: Array<{ name: string; pooled: boolean }>,
): SentinelConfig {
  return {
    sourcePath: null,
    defaultSelection,
    profiles: Object.fromEntries(
      profiles.map(p => [
        p.name,
        {
          name: p.name,
          configDir: `/tmp/${p.name}`,
          env: {},
          pooled: p.pooled,
        },
      ]),
    ),
  }
}

describe('pickProfile -- Fixed', () => {
  test('known literal name short-circuits', () => {
    const cfg = mkConfig('default', [
      { name: 'default', pooled: true },
      { name: 'work', pooled: false },
    ])
    const r = pickProfile(cfg, { input: 'work' })
    expect(r.profile.name).toBe('work')
    expect(r.picker).toBe('fixed')
    expect(r.reason).toBe('literal')
  })

  test('unknown literal name throws with helpful message', () => {
    const cfg = mkConfig('default', [{ name: 'default', pooled: true }])
    expect(() => pickProfile(cfg, { input: 'ghost' })).toThrow(/unknown profile "ghost"/)
  })

  test('fixed wins regardless of defaultSelection', () => {
    const cfg = mkConfig('balanced', [
      { name: 'default', pooled: true },
      { name: 'work', pooled: false },
      { name: 'alt', pooled: true },
    ])
    const r = pickProfile(cfg, { input: 'work', liveLoad: () => 99 })
    expect(r.profile.name).toBe('work')
    expect(r.picker).toBe('fixed')
  })
})

describe('pickProfile -- Balanced', () => {
  test('picks least-loaded pooled profile', () => {
    const cfg = mkConfig('default', [
      { name: 'default', pooled: true },
      { name: 'alt', pooled: true },
      { name: 'work', pooled: true },
    ])
    const loads: Record<string, number> = { default: 5, alt: 1, work: 3 }
    const r = pickProfile(cfg, { input: 'balanced', liveLoad: n => loads[n] ?? 0 })
    expect(r.profile.name).toBe('alt')
    expect(r.picker).toBe('balanced')
    expect(r.reason).toBe('least-active')
    expect(r.pool).toEqual(['alt', 'default', 'work'])
  })

  test('ties broken by name (stable, alphabetical)', () => {
    const cfg = mkConfig('default', [
      { name: 'zebra', pooled: true },
      { name: 'apple', pooled: true },
      { name: 'banana', pooled: true },
    ])
    const r = pickProfile(cfg, { input: 'balanced', liveLoad: () => 7 })
    expect(r.profile.name).toBe('apple')
  })

  test('skips non-pooled profiles', () => {
    const cfg = mkConfig('default', [
      { name: 'default', pooled: true },
      { name: 'work', pooled: false },
      { name: 'alt', pooled: true },
    ])
    // 'work' would win on load but is excluded from the pool.
    const loads: Record<string, number> = { default: 4, alt: 2, work: 0 }
    const r = pickProfile(cfg, { input: 'balanced', liveLoad: n => loads[n] ?? 0 })
    expect(r.profile.name).toBe('alt')
    expect(r.pool).toEqual(['alt', 'default'])
  })

  test('empty pool falls back to default', () => {
    const cfg = mkConfig('default', [
      { name: 'default', pooled: false },
      { name: 'work', pooled: false },
    ])
    const r = pickProfile(cfg, { input: 'balanced', liveLoad: () => 0 })
    expect(r.profile.name).toBe('default')
    expect(r.picker).toBe('default')
    expect(r.reason).toBe('fallback:empty-pool')
  })

  test('zero loads -> first pooled profile alphabetically', () => {
    const cfg = mkConfig('default', [
      { name: 'default', pooled: true },
      { name: 'alpha', pooled: true },
    ])
    const r = pickProfile(cfg, { input: 'balanced', liveLoad: () => 0 })
    expect(r.profile.name).toBe('alpha')
  })
})

describe('pickProfile -- Random', () => {
  test('picks only from pooled profiles', () => {
    const cfg = mkConfig('default', [
      { name: 'default', pooled: true },
      { name: 'work', pooled: false },
      { name: 'alt', pooled: true },
    ])
    // Run many times with a seeded sequence; ensure 'work' never appears.
    let i = 0
    const seq = [0.0, 0.25, 0.5, 0.75, 0.99]
    const rand = () => seq[i++ % seq.length]
    for (let n = 0; n < 50; n++) {
      const r = pickProfile(cfg, { input: 'random', rand })
      expect(r.profile.pooled).toBe(true)
      expect(['alt', 'default']).toContain(r.profile.name)
    }
  })

  test('deterministic with seeded RNG -- 0 picks first', () => {
    const cfg = mkConfig('default', [
      { name: 'alpha', pooled: true },
      { name: 'beta', pooled: true },
    ])
    const r = pickProfile(cfg, { input: 'random', rand: () => 0 })
    expect(r.profile.name).toBe('alpha')
    expect(r.picker).toBe('random')
    expect(r.reason).toBe('random')
  })

  test('deterministic with seeded RNG -- 0.6 picks second of two', () => {
    const cfg = mkConfig('default', [
      { name: 'alpha', pooled: true },
      { name: 'beta', pooled: true },
    ])
    const r = pickProfile(cfg, { input: 'random', rand: () => 0.6 })
    expect(r.profile.name).toBe('beta')
  })

  test('empty pool falls back to default', () => {
    const cfg = mkConfig('default', [{ name: 'default', pooled: false }])
    const r = pickProfile(cfg, { input: 'random', rand: () => 0 })
    expect(r.profile.name).toBe('default')
    expect(r.picker).toBe('default')
    expect(r.reason).toBe('fallback:empty-pool')
  })
})

describe('pickProfile -- defaultSelection drives no-input spawns', () => {
  test('config defaultSelection=default -> picks default profile', () => {
    const cfg = mkConfig('default', [
      { name: 'default', pooled: true },
      { name: 'alt', pooled: true },
    ])
    const r = pickProfile(cfg, {})
    expect(r.profile.name).toBe('default')
    expect(r.picker).toBe('default')
    expect(r.reason).toBe('default')
  })

  test('config defaultSelection=balanced -> behaves as Balanced', () => {
    const cfg = mkConfig('balanced', [
      { name: 'default', pooled: true },
      { name: 'alt', pooled: true },
    ])
    const loads: Record<string, number> = { default: 3, alt: 0 }
    const r = pickProfile(cfg, { liveLoad: n => loads[n] ?? 0 })
    expect(r.profile.name).toBe('alt')
    expect(r.picker).toBe('balanced')
  })

  test('config defaultSelection=random -> behaves as Random', () => {
    const cfg = mkConfig('random', [
      { name: 'alpha', pooled: true },
      { name: 'beta', pooled: true },
    ])
    const r = pickProfile(cfg, { rand: () => 0 })
    expect(r.profile.name).toBe('alpha')
    expect(r.picker).toBe('random')
  })

  test("input='default' token also routes through defaultSelection", () => {
    const cfg = mkConfig('balanced', [
      { name: 'default', pooled: true },
      { name: 'alt', pooled: true },
    ])
    const loads: Record<string, number> = { default: 0, alt: 5 }
    const r = pickProfile(cfg, { input: 'default', liveLoad: n => loads[n] ?? 0 })
    // 'default' input + defaultSelection=balanced -> balanced wins.
    expect(r.picker).toBe('balanced')
    expect(r.profile.name).toBe('default')
  })
})

// Sanity check for the smoke path described in plan-sentinel-profiles.md:
// after the picker chose `work`, the existing Phase 2 env-injection code path
// (cleanSentinelEnv + ResolvedProfile.env merge in src/sentinel/index.ts)
// must still see configDir + env intact -- the picker MUST return the bundle
// untouched, not a NAME-only summary. If a future refactor strips fields,
// CC transcripts would silently land in the wrong configDir.
describe('pickProfile -- returns full ResolvedProfile bundle (env injection sanity)', () => {
  test('configDir + env preserved through fixed pick', () => {
    const cfg: SentinelConfig = {
      sourcePath: null,
      defaultSelection: 'default',
      profiles: {
        default: { name: 'default', configDir: '/home/.claude', env: {}, pooled: true },
        work: {
          name: 'work',
          configDir: '/home/.claude-work',
          env: { ANTHROPIC_API_KEY: 'sk-test' },
          pooled: true,
        },
      },
    }
    const r = pickProfile(cfg, { input: 'work' })
    expect(r.profile.configDir).toBe('/home/.claude-work')
    expect(r.profile.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' })
  })
})

describe('pickProfile -- balanced without a load source treats all as zero', () => {
  test('first pooled profile (alphabetical) wins when no load source given', () => {
    const cfg = mkConfig('default', [
      { name: 'zebra', pooled: true },
      { name: 'apple', pooled: true },
    ])
    const r = pickProfile(cfg, { input: 'balanced' })
    expect(r.profile.name).toBe('apple')
    expect(r.picker).toBe('balanced')
  })
})
