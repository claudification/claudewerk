import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeConfigDir } from './claude-config-dir'

describe('claudeConfigDir', () => {
  test('falls back to ~/.claude when CLAUDE_CONFIG_DIR unset', () => {
    expect(claudeConfigDir({})).toBe(join(homedir(), '.claude'))
  })

  test('falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude'))
  })

  test('honors CLAUDE_CONFIG_DIR override', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/alt-claude' })).toBe('/tmp/alt-claude')
  })

  test('preserves trailing-slashless override verbatim (no normalization)', () => {
    // We want CLAUDE_CONFIG_DIR to pass through untouched -- normalization is
    // CC's problem, not ours, and surprising mutation would mask bugs.
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/y/' })).toBe('/x/y/')
  })
})
