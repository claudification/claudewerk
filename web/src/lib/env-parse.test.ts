/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { applySubagentCapEnv, parseEnvText } from './env-parse'

describe('applySubagentCapEnv', () => {
  test('maps both caps to CLAUDE_CODE_* env vars', () => {
    const env = applySubagentCapEnv(null, { maxConcurrentSubagents: '8', maxSubagentSpawnDepth: '2' })
    expect(env).toEqual({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '8',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2',
    })
  })

  test('merges onto an existing env without clobbering it', () => {
    const env = applySubagentCapEnv({ FOO: 'bar' }, { maxConcurrentSubagents: '4' })
    expect(env).toEqual({ FOO: 'bar', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4' })
  })

  test('returns the base untouched when no caps are set', () => {
    expect(applySubagentCapEnv(null, {})).toBeNull()
    const base = { FOO: 'bar' }
    expect(applySubagentCapEnv(base, { maxConcurrentSubagents: '', maxSubagentSpawnDepth: '  ' })).toBe(base)
  })

  test('ignores blank, non-numeric, and < 1 values (CC applies its own defaults)', () => {
    expect(applySubagentCapEnv(null, { maxConcurrentSubagents: 'abc', maxSubagentSpawnDepth: '0' })).toBeNull()
  })

  test('floors fractional input to an integer string', () => {
    const env = applySubagentCapEnv(null, { maxConcurrentSubagents: '12.9' })
    expect(env).toEqual({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '12' })
  })

  test('composes with parseEnvText output', () => {
    const [parsed] = parseEnvText('FOO=bar')
    const env = applySubagentCapEnv(parsed, { maxSubagentSpawnDepth: '3' })
    expect(env).toEqual({ FOO: 'bar', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3' })
  })
})
