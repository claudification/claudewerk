import { describe, expect, it } from 'bun:test'
import { ptyCrossBoundaryEnvEntry, ptyCrossBoundaryEnvKeys, shouldInjectConfigDir } from './pty-env'
import type { ResolvedProfile } from './sentinel-config'

function profile(partial: Partial<ResolvedProfile>): ResolvedProfile {
  return {
    name: 'p',
    configDir: '',
    env: {},
    pool: 'default',
    weight: 1,
    ...partial,
  }
}

describe('shouldInjectConfigDir', () => {
  it('is false for undefined and empty (implicit ~/.claude default)', () => {
    expect(shouldInjectConfigDir(undefined)).toBe(false)
    expect(shouldInjectConfigDir('')).toBe(false)
  })

  it('is true for a concrete configDir', () => {
    expect(shouldInjectConfigDir('/Users/x/.claude-work')).toBe(true)
  })
})

describe('ptyCrossBoundaryEnvKeys', () => {
  it('forwards nothing for the default profile with no custom env', () => {
    // The implicit-default profile (no configDir, no env) must leave the PTY
    // path byte-for-byte unchanged -- no CLAUDWERK_PTY_ENV_KEYS gets emitted.
    expect(ptyCrossBoundaryEnvKeys(profile({}), undefined)).toBe('')
    expect(ptyCrossBoundaryEnvKeys(undefined, undefined)).toBe('')
    expect(ptyCrossBoundaryEnvKeys(undefined, {})).toBe('')
  })

  it('forwards CLAUDE_CONFIG_DIR when a profile resolves a configDir', () => {
    expect(ptyCrossBoundaryEnvKeys(profile({ configDir: '/p/.claude' }), undefined)).toBe('CLAUDE_CONFIG_DIR')
  })

  it('forwards every profile.env key after the config dir', () => {
    const keys = ptyCrossBoundaryEnvKeys(
      profile({ configDir: '/p/.claude', env: { ANTHROPIC_API_KEY: 'sk', FOO: 'bar' } }),
      undefined,
    )
    expect(keys).toBe('CLAUDE_CONFIG_DIR ANTHROPIC_API_KEY FOO')
  })

  it('forwards profile.env even when configDir is the implicit default', () => {
    // API-key profile with no custom configDir: env still must cross.
    expect(ptyCrossBoundaryEnvKeys(profile({ env: { ANTHROPIC_API_KEY: 'sk' } }), undefined)).toBe('ANTHROPIC_API_KEY')
  })

  it('appends RCLAUDE_CUSTOM_ENV when user custom env is present', () => {
    expect(ptyCrossBoundaryEnvKeys(profile({ configDir: '/p/.claude' }), { MY_VAR: 'v' })).toBe(
      'CLAUDE_CONFIG_DIR RCLAUDE_CUSTOM_ENV',
    )
    expect(ptyCrossBoundaryEnvKeys(undefined, { MY_VAR: 'v' })).toBe('RCLAUDE_CUSTOM_ENV')
  })

  it('ignores an empty custom env object', () => {
    expect(ptyCrossBoundaryEnvKeys(profile({ configDir: '/p/.claude' }), {})).toBe('CLAUDE_CONFIG_DIR')
  })

  it('appends caller extraKeys last so they survive the tmux seam', () => {
    // The PTY path always sets CLAUDWERK_THINKING_DISPLAY; without forwarding
    // it the tmux pane inherits the stale server env and the opt-in evaporates.
    expect(ptyCrossBoundaryEnvKeys(undefined, undefined, ['CLAUDWERK_THINKING_DISPLAY'])).toBe(
      'CLAUDWERK_THINKING_DISPLAY',
    )
    expect(
      ptyCrossBoundaryEnvKeys(profile({ configDir: '/p/.claude' }), undefined, ['CLAUDWERK_THINKING_DISPLAY']),
    ).toBe('CLAUDE_CONFIG_DIR CLAUDWERK_THINKING_DISPLAY')
  })

  it('defaults extraKeys to empty (existing callers unchanged)', () => {
    expect(ptyCrossBoundaryEnvKeys(undefined, undefined)).toBe('')
  })

  it('ptyCrossBoundaryEnvEntry spreads the var, or nothing when there are no keys', () => {
    expect(ptyCrossBoundaryEnvEntry(undefined, undefined)).toEqual({})
    expect(
      ptyCrossBoundaryEnvEntry(profile({ configDir: '/p/.claude' }), undefined, ['CLAUDWERK_THINKING_DISPLAY']),
    ).toEqual({ CLAUDWERK_PTY_ENV_KEYS: 'CLAUDE_CONFIG_DIR CLAUDWERK_THINKING_DISPLAY' })
  })

  it('produces only whitespace-safe identifier names (bash word-split safe)', () => {
    const keys = ptyCrossBoundaryEnvKeys(profile({ configDir: '/p/.claude', env: { A_B: '1', C9: '2' } }), { X: 'y' })
    for (const name of keys.split(' ')) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
  })
})
