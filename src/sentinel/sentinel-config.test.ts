/**
 * Tier 1 unit tests for `sentinel-config` -- loader, profile resolution,
 * configDirFor, broker-safe summaries.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configDirFor,
  DEFAULT_POOL_NAME,
  DEFAULT_PROFILE_NAME,
  defaultConfigPath,
  getPools,
  loadSentinelConfig,
  profileIsAuthed,
  profileNameForConfigDir,
  profileSummaries,
  resolveProfile,
} from './sentinel-config'

let scratch = ''
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'sentinel-cfg-'))
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('defaultConfigPath', () => {
  test('honors XDG_CONFIG_HOME when set', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/jonas')).toBe('/xdg/rclaude/sentinel.json')
  })

  test('falls back to ~/.config when XDG_CONFIG_HOME unset', () => {
    expect(defaultConfigPath({}, '/home/jonas')).toBe('/home/jonas/.config/rclaude/sentinel.json')
  })

  test('falls back to ~/.config when XDG_CONFIG_HOME empty', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '' }, '/home/jonas')).toBe('/home/jonas/.config/rclaude/sentinel.json')
  })
})

describe('loadSentinelConfig -- tolerant defaults', () => {
  test('missing file yields implicit default profile in the default pool', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'no-such.json') })
    expect(cfg.sourcePath).toBeNull()
    // Synth default flipped to 'balanced' in Phase 3 of
    // plan-sentinel-profile-usage -- single-profile installs are unaffected
    // (balanced over a one-member pool is a no-op pick), multi-profile
    // installs get Smart Balance out of the box.
    expect(cfg.defaultSelection).toBe('balanced')
    expect(cfg.defaultPool).toBe(DEFAULT_POOL_NAME)
    expect(Object.keys(cfg.profiles)).toEqual([DEFAULT_PROFILE_NAME])
    expect(cfg.profiles[DEFAULT_PROFILE_NAME].configDir).toBe(join(homedir(), '.claude'))
    expect(cfg.profiles[DEFAULT_PROFILE_NAME].pool).toBe(DEFAULT_POOL_NAME)
  })

  test('empty file is treated as no profiles configured', () => {
    const path = join(scratch, 'empty.json')
    writeFileSync(path, '')
    const cfg = loadSentinelConfig({ configPath: path })
    expect(cfg.sourcePath).toBe(path)
    expect(Object.keys(cfg.profiles)).toEqual([DEFAULT_PROFILE_NAME])
  })

  test('empty object yields implicit default profile', () => {
    const path = join(scratch, 'empty-obj.json')
    writeFileSync(path, '{}')
    const cfg = loadSentinelConfig({ configPath: path })
    expect(cfg.sourcePath).toBe(path)
    // See sibling test above for the synth-default flip rationale.
    expect(cfg.defaultSelection).toBe('balanced')
    expect(cfg.defaultPool).toBe(DEFAULT_POOL_NAME)
    expect(Object.keys(cfg.profiles)).toEqual([DEFAULT_PROFILE_NAME])
  })
})

describe('loadSentinelConfig -- with profiles', () => {
  test('parses a full profile entry, omitted pool -> default pool', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(
      path,
      JSON.stringify({
        defaultSelection: 'balanced',
        profiles: {
          work: {
            configDir: '~/.claude-work',
            env: { ANTHROPIC_API_KEY: 'sk-test' },
            spawnRoot: '~/work',
            label: 'Work org',
            color: '#f59e0b',
          },
        },
      }),
    )
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/jonas' })
    expect(cfg.defaultSelection).toBe('balanced')
    const work = cfg.profiles.work
    expect(work.configDir).toBe('/home/jonas/.claude-work')
    expect(work.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' })
    expect(work.spawnRoot).toBe('/home/jonas/work')
    expect(work.pool).toBe(DEFAULT_POOL_NAME)
    expect(work.label).toBe('Work org')
    expect(work.color).toBe('#f59e0b')
  })

  test('explicit named pool round-trips', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(
      path,
      JSON.stringify({
        defaultPool: 'work',
        profiles: {
          'work-1': { configDir: '~/.claude-w1', pool: 'work' },
          'work-2': { configDir: '~/.claude-w2', pool: 'work' },
          private: { configDir: '~/.claude-priv', pool: null },
        },
      }),
    )
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/j' })
    expect(cfg.defaultPool).toBe('work')
    expect(cfg.profiles['work-1'].pool).toBe('work')
    expect(cfg.profiles['work-2'].pool).toBe('work')
    expect(cfg.profiles.private.pool).toBeNull()
    // Implicit default profile lands in the "default" pool, NOT the configured defaultPool.
    expect(cfg.profiles[DEFAULT_PROFILE_NAME].pool).toBe(DEFAULT_POOL_NAME)
  })

  test('default profile remains implicit when only other profiles listed', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.claude-work' } } }))
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/jonas' })
    expect(cfg.profiles[DEFAULT_PROFILE_NAME].configDir).toBe('/home/jonas/.claude')
    expect(cfg.profiles.work.configDir).toBe('/home/jonas/.claude-work')
  })

  test('explicit default override is honored', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { default: { configDir: '/custom/default' } } }))
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/jonas' })
    expect(cfg.profiles[DEFAULT_PROFILE_NAME].configDir).toBe('/custom/default')
  })

  test('rejects invalid JSON with the path in the message', () => {
    const path = join(scratch, 'bad.json')
    writeFileSync(path, '{not json')
    expect(() => loadSentinelConfig({ configPath: path })).toThrow(/invalid JSON/)
  })

  test('rejects bad profile name', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { 'Bad Name!': { configDir: '~/.claude-x' } } }))
    expect(() => loadSentinelConfig({ configPath: path })).toThrow(/profile name "Bad Name!"/)
  })

  test('rejects bad defaultSelection', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ defaultSelection: 'roundrobin' }))
    expect(() => loadSentinelConfig({ configPath: path })).toThrow(/defaultSelection/)
  })

  test('rejects bad defaultPool name', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ defaultPool: 'Bad Pool' }))
    expect(() => loadSentinelConfig({ configPath: path })).toThrow(/defaultPool/)
  })

  test('rejects bad per-profile pool name', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.claude-work', pool: 'Bad Pool' } } }))
    expect(() => loadSentinelConfig({ configPath: path })).toThrow(/pool/)
  })

  test('rejects non-string env value', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(
      path,
      JSON.stringify({
        profiles: { work: { configDir: '~/.claude-work', env: { ANTHROPIC_API_KEY: 42 } } },
      }),
    )
    expect(() => loadSentinelConfig({ configPath: path })).toThrow(/env\["ANTHROPIC_API_KEY"\]/)
  })

  test('rejects missing configDir on a profile', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { label: 'x' } } }))
    expect(() => loadSentinelConfig({ configPath: path })).toThrow(/requires a non-empty "configDir"/)
  })
})

describe('resolveProfile + configDirFor', () => {
  test('absent name resolves to default profile', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    expect(resolveProfile(cfg).name).toBe(DEFAULT_PROFILE_NAME)
    expect(configDirFor(cfg)).toBe(join(homedir(), '.claude'))
  })

  test('explicit "default" resolves to default profile', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    expect(resolveProfile(cfg, 'default').name).toBe(DEFAULT_PROFILE_NAME)
  })

  test('selection mode tokens fall back to default', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    expect(resolveProfile(cfg, 'balanced').name).toBe(DEFAULT_PROFILE_NAME)
    expect(resolveProfile(cfg, 'random').name).toBe(DEFAULT_PROFILE_NAME)
  })

  test('named profile resolves to its bundle', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.claude-work' } } }))
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/j' })
    const r = resolveProfile(cfg, 'work')
    expect(r.name).toBe('work')
    expect(r.configDir).toBe('/home/j/.claude-work')
    expect(configDirFor(cfg, 'work')).toBe('/home/j/.claude-work')
  })

  test('unknown profile throws', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    expect(() => resolveProfile(cfg, 'no-such')).toThrow(/unknown profile "no-such"/)
  })
})

describe('profileNameForConfigDir', () => {
  test('returns default when the dir matches the implicit default profile', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    expect(profileNameForConfigDir(cfg, join(homedir(), '.claude'))).toBe(DEFAULT_PROFILE_NAME)
  })

  test('returns the matching profile NAME for a non-default configDir', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.claude-work' } } }))
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/j' })
    expect(profileNameForConfigDir(cfg, '/home/j/.claude-work')).toBe('work')
  })

  test('falls back to default when no profile matches the dir', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    expect(profileNameForConfigDir(cfg, '/nowhere/known')).toBe(DEFAULT_PROFILE_NAME)
  })
})

describe('profileIsAuthed', () => {
  test('false when configDir does not exist', () => {
    expect(profileIsAuthed(join(scratch, 'no-such-dir'))).toBe(false)
  })

  test('false when no creds file present', () => {
    expect(profileIsAuthed(scratch)).toBe(false)
  })

  test('true when .credentials.json has content', () => {
    writeFileSync(join(scratch, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"tok"}}')
    expect(profileIsAuthed(scratch)).toBe(true)
  })

  test('true when .claude.json has content', () => {
    writeFileSync(join(scratch, '.claude.json'), '{"x":1}')
    expect(profileIsAuthed(scratch)).toBe(true)
  })

  test('false when creds file is empty', () => {
    writeFileSync(join(scratch, '.credentials.json'), '')
    expect(profileIsAuthed(scratch)).toBe(false)
  })
})

describe('profileSummaries -- broker-safe slice', () => {
  test('emits pool (string|null) and NEVER includes configDir or env', () => {
    const path = join(scratch, 'cfg.json')
    mkdirSync(join(scratch, '.claude-work'), { recursive: true })
    writeFileSync(join(scratch, '.claude-work', '.credentials.json'), '{"x":1}')
    writeFileSync(
      path,
      JSON.stringify({
        profiles: {
          work: {
            configDir: join(scratch, '.claude-work'),
            env: { ANTHROPIC_API_KEY: 'sk-secret' },
            label: 'Work',
            color: '#f00',
            pool: null,
          },
        },
      }),
    )
    const cfg = loadSentinelConfig({ configPath: path })
    const summaries = profileSummaries(cfg)
    expect(summaries).toHaveLength(2) // implicit default + work
    const work = summaries.find(s => s.name === 'work')!
    expect(work).toEqual({
      name: 'work',
      label: 'Work',
      color: '#f00',
      pool: null,
      weight: 1,
      authed: true,
    })
    // Boundary covenant -- no env, no configDir leak.
    expect(work).not.toHaveProperty('configDir')
    expect(work).not.toHaveProperty('env')
    expect(JSON.stringify(work)).not.toContain('sk-secret')
    expect(JSON.stringify(work)).not.toContain('.claude-work')
  })

  test('default profile reports the default pool', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    const summaries = profileSummaries(cfg)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].name).toBe(DEFAULT_PROFILE_NAME)
    expect(typeof summaries[0].authed).toBe('boolean')
    expect(summaries[0].pool).toBe(DEFAULT_POOL_NAME)
  })
})

describe('getPools -- distinct pool names', () => {
  test('returns sorted unique pool names, excluding null', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(
      path,
      JSON.stringify({
        profiles: {
          'w-1': { configDir: '~/.cw1', pool: 'work' },
          'w-2': { configDir: '~/.cw2', pool: 'work' },
          'alt-1': { configDir: '~/.ca1', pool: 'alt' },
          private: { configDir: '~/.priv', pool: null },
        },
      }),
    )
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/j' })
    // Implicit default profile contributes "default" pool.
    expect(getPools(cfg)).toEqual(['alt', 'default', 'work'])
  })

  test('returns just default when no profiles configured', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    expect(getPools(cfg)).toEqual([DEFAULT_POOL_NAME])
  })
})

describe('loadSentinelConfig -- profile weight (Phase 7b)', () => {
  test('omitted weight defaults to 1 (incl. synthesised default)', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.cw' } } }))
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/j' })
    expect(cfg.profiles.work.weight).toBe(1)
    expect(cfg.profiles.default.weight).toBe(1)
  })

  test('explicit weight is preserved, including 0 (soft drain)', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(
      path,
      JSON.stringify({
        profiles: { big: { configDir: '~/.b', weight: 10 }, drained: { configDir: '~/.d', weight: 0 } },
      }),
    )
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/j' })
    expect(cfg.profiles.big.weight).toBe(10)
    expect(cfg.profiles.drained.weight).toBe(0)
  })

  test('negative weight is rejected', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.cw', weight: -1 } } }))
    expect(() => loadSentinelConfig({ configPath: path, home: '/home/j' })).toThrow(/weight/)
  })

  test('non-number weight is rejected', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.cw', weight: 'heavy' } } }))
    expect(() => loadSentinelConfig({ configPath: path, home: '/home/j' })).toThrow(/weight/)
  })

  test('weight reaches the broker-safe summary', () => {
    const path = join(scratch, 'cfg.json')
    writeFileSync(path, JSON.stringify({ profiles: { work: { configDir: '~/.cw', weight: 5 } } }))
    const cfg = loadSentinelConfig({ configPath: path, home: '/home/j' })
    const work = profileSummaries(cfg).find(s => s.name === 'work')!
    expect(work.weight).toBe(5)
  })
})
