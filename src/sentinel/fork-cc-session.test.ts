/**
 * forkCcSession -- the sentinel-side half of Fork.
 *
 * Runs against a real temp config dir rather than mocks, because the whole
 * point of this seam is on-disk layout: the fork has to land in the same
 * `<configDir>/projects/<slug>/` CC resumes from, and it must never touch the
 * source.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLargeResultFixture } from '../agent-host-common/super-compact/fixtures'
import { transcriptSlug } from '../shared/transcript-path'
import { forkCcSession } from './fork-cc-session'

const CWD = '/repo/some_project.v2' // dots + underscores: the slug cases that bit us
const SOURCE_ID = 'source-session-0001'

let configDir = ''
let projectDir = ''
let sourcePath = ''

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'fork-test-'))
  projectDir = join(configDir, 'projects', transcriptSlug(CWD))
  mkdirSync(projectDir, { recursive: true })
  sourcePath = join(projectDir, `${SOURCE_ID}.jsonl`)
  await Bun.write(sourcePath, buildLargeResultFixture())
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

function fork(over?: number) {
  return forkCcSession({
    cwd: CWD,
    configDir,
    sourceCcSessionId: SOURCE_ID,
    digestOverTokens: over,
    tailTokenBudget: 30,
    genSessionId: () => 'forked-session-9999',
  })
}

describe('forkCcSession', () => {
  test('writes the fork beside the source, named for the new session id', async () => {
    const r = await fork()
    expect(r.ok).toBe(true)
    expect(existsSync(join(projectDir, 'forked-session-9999.jsonl'))).toBe(true)
  })

  test('never modifies the source transcript', async () => {
    const before = await Bun.file(sourcePath).text()
    await fork()
    expect(await Bun.file(sourcePath).text()).toBe(before)
  })

  test('the fork is smaller than the source', async () => {
    const r = await fork()
    if (!r.ok) throw new Error(r.error)
    expect(r.stats.afterTokens).toBeLessThan(r.stats.beforeTokens)
    expect(r.stats.digestedResults).toBeGreaterThan(0)
  })

  test('every entry in the fork carries the NEW session id', async () => {
    await fork()
    const lines = (await Bun.file(join(projectDir, 'forked-session-9999.jsonl')).text())
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { sessionId?: string })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(l => l.sessionId === 'forked-session-9999')).toBe(true)
  })

  test('links back to the source so the fold stays recoverable', async () => {
    await fork()
    const text = await Bun.file(join(projectDir, 'forked-session-9999.jsonl')).text()
    expect(text).toContain(SOURCE_ID)
  })

  test('digestOverTokens 0 gives a faithful full copy', async () => {
    const r = await fork(0)
    if (!r.ok) throw new Error(r.error)
    expect(r.stats.digestedResults).toBe(0)
  })

  // Regression: CC derives its transcript directory from the cwd it is LAUNCHED
  // in. A fork destined for a worktree but written beside the source is
  // invisible to `--resume` -- CC finds nothing and silently starts fresh,
  // which looks like "fork lost all context" rather than an error.
  test('retargeting writes the fork under the TARGET directory, not the source', async () => {
    const targetCwd = '/repo/some_project.v2/.claude/worktrees/feat-x'
    const r = await forkCcSession({
      cwd: CWD,
      targetCwd,
      configDir,
      sourceCcSessionId: SOURCE_ID,
      genSessionId: () => 'forked-into-worktree',
    })
    expect(r.ok).toBe(true)

    const targetDir = join(configDir, 'projects', transcriptSlug(targetCwd))
    expect(existsSync(join(targetDir, 'forked-into-worktree.jsonl'))).toBe(true)
    // and NOT beside the source
    expect(existsSync(join(projectDir, 'forked-into-worktree.jsonl'))).toBe(false)
  })

  test('creates the target directory when the worktree does not exist yet', async () => {
    // The worktree is created at spawn time, AFTER the fork is written.
    const targetCwd = '/repo/brand_new.place/wt'
    const r = await forkCcSession({
      cwd: CWD,
      targetCwd,
      configDir,
      sourceCcSessionId: SOURCE_ID,
      genSessionId: () => 'fork-into-new-dir',
    })
    expect(r.ok).toBe(true)
    expect(existsSync(join(configDir, 'projects', transcriptSlug(targetCwd), 'fork-into-new-dir.jsonl'))).toBe(true)
  })

  test('carries the provenance block into the fold preamble, at the very top', async () => {
    const r = await forkCcSession({
      cwd: CWD,
      configDir,
      sourceCcSessionId: SOURCE_ID,
      provenanceBlock: '<forked from_conversation="conv_parent">from the parent</forked>',
      tailTokenBudget: 30,
      genSessionId: () => 'fork-with-provenance',
    })
    expect(r.ok).toBe(true)

    const first = JSON.parse(
      (await Bun.file(join(projectDir, 'fork-with-provenance.jsonl')).text()).split('\n')[0],
    ) as { message: { content: unknown } }
    const text = JSON.stringify(first.message.content)
    expect(text).toContain('conv_parent')
    // Ahead of the fold's own header, so a skim still catches it.
    expect(text.indexOf('forked')).toBeLessThan(text.indexOf('super-compacted'))
  })

  test('reports the attempted path when the source is missing', async () => {
    const r = await forkCcSession({ cwd: CWD, configDir, sourceCcSessionId: 'nope' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.error).toContain('nope.jsonl') // names what it looked for, not just "not found"
  })
})
