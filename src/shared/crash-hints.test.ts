import { describe, expect, test } from 'bun:test'
import { CRASH_HINTS, formatHintCatalog, matchCrashHint } from './crash-hints'

describe('crash-hints', () => {
  test('seed catalog has the cwd-removed entry with a remedy', () => {
    expect(CRASH_HINTS['cwd-removed']).toBeDefined()
    expect(CRASH_HINTS['cwd-removed'].remedy).toMatch(/worktree|project root/i)
  })

  test('matches the worktree-cleanup CWD crash signature', () => {
    const m = matchCrashHint('Error: ENOENT: no such file or directory, uv_cwd')
    expect(m?.key).toBe('cwd-removed')
    expect(m?.hint.remedy).toMatch(/do not blind-retry/i)
  })

  test('matches "working directory" phrasing too', () => {
    expect(matchCrashHint('fatal: could not read the working directory')?.key).toBe('cwd-removed')
  })

  test('unknown crash text returns null (no false positive)', () => {
    expect(matchCrashHint('TypeError: undefined is not a function at foo.ts:12')).toBeNull()
    expect(matchCrashHint('')).toBeNull()
  })

  test('formatHintCatalog renders every entry with signature + cause + remedy', () => {
    const cat = formatHintCatalog()
    expect(cat).toContain('[cwd-removed]')
    expect(cat).toContain('cause:')
    expect(cat).toContain('remedy:')
    for (const key of Object.keys(CRASH_HINTS)) expect(cat).toContain(`[${key}]`)
  })
})
