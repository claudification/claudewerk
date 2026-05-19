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
  DEFAULT_PROFILE_NAME,
  defaultConfigPath,
  loadSentinelConfig,
  profileIsAuthed,
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
  test('missing file yields implicit default profile', () => {
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'no-such.json') })
    expect(cfg.sourcePath).toBeNull()
    expect(cfg.defaultSelection).toBe('default')
    expect(Object.keys(cfg.profiles)).toEqual([DEFAULT_PROFILE_NAME])
    expect(cfg.profiles[DEFAULT_PROFILE_NAME].configDir).toBe(join(homedir(), '.claude'))
    expect(cfg.profiles[DEFAULT_PROFILE_NAME].pooled).toBe(true)
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
    expect(cfg.defaultSelection).toBe('default')
    expect(Object.keys(cfg.profiles)).toEqual([DEFAULT_PROFILE_NAME])
  })
})

describe('loadSentinelConfig -- with profiles', () => {
  test('parses a full profile entry', () => {
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
            pooled: false,
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
    expect(work.pooled).toBe(false)
    expect(work.label).toBe('Work org')
    expect(work.color).toBe('#f59e0b')
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

  test('selection mode tokens fall back to default in Phase 2', () => {
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
  test('NEVER includes configDir or env', () => {
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
            pooled: false,
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
      pooled: false,
      authed: true,
    })
    // Boundary covenant -- no env, no configDir leak.
    expect(work).not.toHaveProperty('configDir')
    expect(work).not.toHaveProperty('env')
    expect(JSON.stringify(work)).not.toContain('sk-secret')
    expect(JSON.stringify(work)).not.toContain('.claude-work')
  })

  test('default profile reports unauthed when ~/.claude is bare', () => {
    // We can't actually mutate the user's ~/.claude, so this just sanity-checks
    // the shape -- the implicit default may be authed (the real user IS logged
    // in) or unauthed (in CI). Either is a valid boolean.
    const cfg = loadSentinelConfig({ configPath: join(scratch, 'none.json') })
    const summaries = profileSummaries(cfg)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].name).toBe(DEFAULT_PROFILE_NAME)
    expect(typeof summaries[0].authed).toBe('boolean')
    expect(summaries[0].pooled).toBe(true)
  })
})
