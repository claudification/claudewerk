import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessNdjsonPath, parseHookStage, RingBuffer, tailHeadlessNdjson } from './spawn-error'

function tmp(prefix = 'spawn-error-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('RingBuffer', () => {
  test('throws on non-positive capacity', () => {
    expect(() => new RingBuffer<string>(0)).toThrow()
    expect(() => new RingBuffer<string>(-1)).toThrow()
  })

  test('preserves order under capacity', () => {
    const r = new RingBuffer<string>(3)
    r.push('a')
    r.push('b')
    expect(r.snapshot()).toEqual(['a', 'b'])
    expect(r.size).toBe(2)
  })

  test('drops oldest when over capacity', () => {
    const r = new RingBuffer<string>(3)
    r.push('a')
    r.push('b')
    r.push('c')
    r.push('d')
    expect(r.snapshot()).toEqual(['b', 'c', 'd'])
    expect(r.size).toBe(3)
  })

  test('snapshot returns a copy (mutations do not affect ring)', () => {
    const r = new RingBuffer<string>(3)
    r.push('a')
    const snap = r.snapshot()
    snap.push('x')
    expect(r.snapshot()).toEqual(['a'])
  })
})

describe('parseHookStage', () => {
  test('extracts the hook name from "X hook failed"', () => {
    expect(
      parseHookStage([
        '# headless stream log - 2026-05-28T17:32:44.728Z',
        '# pid=7670',
        'ERR Error creating worktree: WorktreeCreate hook failed: bash "/tmp/foo.sh": fatal',
      ]),
    ).toBe('WorktreeCreate')
  })

  test('extracts the hook name from "during X hook"', () => {
    expect(parseHookStage(['ERR Error during PostToolUse hook: handler crashed'])).toBe('PostToolUse')
  })

  test('extracts from "during the X hook"', () => {
    expect(parseHookStage(['Error occurred during the SessionStart hook'])).toBe('SessionStart')
  })

  test('falls back to "claude-launch" when ERR but no hook recognized', () => {
    expect(parseHookStage(['ERR something went wrong but no hook mentioned'])).toBe('claude-launch')
  })

  test('returns undefined on clean lines', () => {
    expect(parseHookStage(['just some normal output', '{"type":"init"}'])).toBeUndefined()
  })

  test('returns undefined on empty input', () => {
    expect(parseHookStage([])).toBeUndefined()
  })

  test('prefers explicit "hook failed" over "claude-launch" fallback', () => {
    expect(parseHookStage(['ERR some preamble', 'ERR WorktreeCreate hook failed: nope'])).toBe('WorktreeCreate')
  })
})

describe('tailHeadlessNdjson', () => {
  test('returns [] when file missing', () => {
    expect(tailHeadlessNdjson('/nonexistent/path/nope.ndjsonl', 10)).toEqual([])
  })

  test('returns [] when file is empty', () => {
    const dir = tmp()
    const path = join(dir, 'empty.ndjsonl')
    writeFileSync(path, '')
    expect(tailHeadlessNdjson(path, 10)).toEqual([])
  })

  test('skips comment lines (#) and empty lines', () => {
    const dir = tmp()
    const path = join(dir, 'log.ndjsonl')
    writeFileSync(path, ['# header', '', 'first', '', '# pid=123', 'second'].join('\n'))
    expect(tailHeadlessNdjson(path, 10)).toEqual(['first', 'second'])
  })

  test('honors maxLines limit (keeps tail)', () => {
    const dir = tmp()
    const path = join(dir, 'log.ndjsonl')
    writeFileSync(path, ['a', 'b', 'c', 'd', 'e'].join('\n'))
    expect(tailHeadlessNdjson(path, 3)).toEqual(['c', 'd', 'e'])
  })

  test('reproduces the chain-fh-p2 failure shape', () => {
    const dir = tmp()
    const path = join(dir, 'log.ndjsonl')
    writeFileSync(
      path,
      [
        '# headless stream log - 2026-05-28T17:32:44.728Z',
        '# pid=7670',
        `ERR Error creating worktree: WorktreeCreate hook failed: bash "/tmp/foo.sh": Preparing worktree (new branch 'worktree-frontend-health')`,
        `fatal: a branch named 'worktree-frontend-health' already exists`,
      ].join('\n'),
    )
    const tail = tailHeadlessNdjson(path, 20)
    expect(tail.length).toBe(2)
    expect(parseHookStage(tail)).toBe('WorktreeCreate')
  })
})

describe('headlessNdjsonPath', () => {
  test('builds the canonical .rclaude/settings path', () => {
    expect(headlessNdjsonPath('/proj/foo', 'abcd1234')).toBe('/proj/foo/.rclaude/settings/headless-abcd1234.ndjsonl')
  })
})
