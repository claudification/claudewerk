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

  test('reports the attempted path when the source is missing', async () => {
    const r = await forkCcSession({ cwd: CWD, configDir, sourceCcSessionId: 'nope' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.error).toContain('nope.jsonl') // names what it looked for, not just "not found"
  })
})
