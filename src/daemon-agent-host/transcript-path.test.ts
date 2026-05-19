/**
 * Tier 1 unit tests for `transcript-path` -- the JSONL path derivation shared
 * by the transcript bridge and the session observer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ccSessionIdFromJsonl, transcriptJsonlPath, transcriptProjectDir } from './transcript-path'

describe('transcriptProjectDir', () => {
  test('slugs an absolute cwd under ~/.claude/projects', () => {
    // process.cwd() exists, so realpathSync succeeds -- derive the expected
    // slug from the resolved path to stay symlink-correct on every platform.
    const dir = transcriptProjectDir(process.cwd())
    const slug = realpathSync(process.cwd()).replace(/[/._]/g, '-')
    expect(dir).toBe(join(homedir(), '.claude', 'projects', slug))
  })

  test('falls back to the raw path when cwd does not exist', () => {
    const dir = transcriptProjectDir('/no/such/cwd_x.y')
    expect(dir).toBe(join(homedir(), '.claude', 'projects', '-no-such-cwd-x-y'))
  })
})

describe('transcriptProjectDir -- symlink resolution', () => {
  let realDir = ''
  let linkPath = ''

  beforeAll(() => {
    realDir = realpathSync(mkdtempSync(join(tmpdir(), 'tx-path-real-')))
    linkPath = join(realpathSync(tmpdir()), `tx-path-link-${Date.now()}`)
    symlinkSync(realDir, linkPath)
  })
  afterAll(() => {
    rmSync(linkPath, { force: true })
    rmSync(realDir, { recursive: true, force: true })
  })

  test('resolves a symlinked cwd to its real path before slugging', () => {
    // CC slugs the REAL path; the slug must match the resolved target, not the link.
    const viaLink = transcriptProjectDir(linkPath)
    const viaReal = transcriptProjectDir(realDir)
    expect(viaLink).toBe(viaReal)
  })
})

describe('transcriptJsonlPath', () => {
  test('appends <ccSessionId>.jsonl to the project dir', () => {
    const path = transcriptJsonlPath('/no/such/cwd', 'sess-abc123')
    expect(path).toBe(join(transcriptProjectDir('/no/such/cwd'), 'sess-abc123.jsonl'))
  })
})

describe('ccSessionIdFromJsonl', () => {
  test('extracts the id from a <id>.jsonl name', () => {
    expect(ccSessionIdFromJsonl('4d7508e6-1234.jsonl')).toBe('4d7508e6-1234')
  })

  test('returns null for a non-jsonl name', () => {
    expect(ccSessionIdFromJsonl('roster.json')).toBeNull()
    expect(ccSessionIdFromJsonl('notes.txt')).toBeNull()
  })

  test('returns null for a bare ".jsonl" with no id', () => {
    expect(ccSessionIdFromJsonl('.jsonl')).toBeNull()
  })
})
