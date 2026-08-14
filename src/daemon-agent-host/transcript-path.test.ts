/**
 * Tier 1 unit tests for `transcript-path` -- the JSONL path derivation shared
 * by the transcript bridge and the session observer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeConfigDir } from '../shared/claude-config-dir'
import { ccSessionIdFromJsonl, transcriptJsonlPath, transcriptProjectDir } from './transcript-path'

// The config root is `claudeConfigDir()`, NOT a hardcoded `~/.claude`: a
// `CLAUDE_CONFIG_DIR` override is a supported setup (and is the author's), so
// asserting the default path made these cases fail for the exact configuration
// the code is written to handle.
const projectsRoot = join(claudeConfigDir(), 'projects')

describe('transcriptProjectDir', () => {
  test('slugs an absolute cwd under the CC projects root', () => {
    // process.cwd() exists, so realpathSync succeeds -- derive the expected
    // slug from the resolved path to stay symlink-correct on every platform.
    const dir = transcriptProjectDir(process.cwd())
    const slug = realpathSync(process.cwd()).replace(/[/._]/g, '-')
    expect(dir).toBe(join(projectsRoot, slug))
  })

  test('falls back to the raw path when cwd does not exist', () => {
    const dir = transcriptProjectDir('/no/such/cwd_x.y')
    expect(dir).toBe(join(projectsRoot, '-no-such-cwd-x-y'))
  })

  test('honours a CLAUDE_CONFIG_DIR override', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cc-override-probe'
    try {
      expect(transcriptProjectDir('/no/such/cwd_x.y')).toBe(
        join('/tmp/cc-override-probe', 'projects', '-no-such-cwd-x-y'),
      )
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
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
