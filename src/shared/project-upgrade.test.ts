import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectTask, listProjectTasks } from './project-store'
import { upgradeProjectBoard } from './project-upgrade'
import type { TaskStatus } from './task-statuses'

let root: string
const NOW = Date.parse('2026-08-12T00:45:00.000Z')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'board-upgrade-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function lane(status: TaskStatus, id: string, content: string): void {
  mkdirSync(join(root, '.rclaude/project', status), { recursive: true })
  writeFileSync(join(root, '.rclaude/project', status, `${id}.md`), content)
}
const cardFile = (id: string) => join(root, '.rclaude/project/cards', `${id}.md`)

describe('upgradeProjectBoard', () => {
  test('no board at all is a clean no-op', () => {
    const r = upgradeProjectBoard(root, { nowMs: NOW })
    expect(r.noBoard).toBe(true)
    expect(r.moved).toEqual([])
  })

  test('moves every lane card into cards/ with its lane pinned as status', () => {
    lane('open', 'a', '---\ntitle: A\n---\n\nbody a')
    lane('done', 'b', '---\ntitle: B\npriority: high\n---\n\nbody b')

    const r = upgradeProjectBoard(root, { nowMs: NOW })
    expect(r.moved.sort()).toEqual(['a', 'b'])
    expect(r.failures).toEqual([])

    expect(existsSync(join(root, '.rclaude/project/open/a.md'))).toBe(false)
    expect(readFileSync(cardFile('a'), 'utf8')).toContain('status: open')
    expect(getProjectTask(root, 'b')?.status).toBe('done')
    expect(getProjectTask(root, 'b')?.priority).toBe('high')
    expect(getProjectTask(root, 'b')?.body).toBe('body b')
  })

  test('the lane directory beats a stale status: key in the file', () => {
    lane('in-review', 'stale', '---\ntitle: S\nstatus: inbox\n---\n\nx')
    upgradeProjectBoard(root, { nowMs: NOW })
    expect(getProjectTask(root, 'stale')?.status).toBe('in-review')
  })

  test('preserves unknown frontmatter (gate evidence) verbatim', () => {
    lane('in-review', 'ev', '---\ntitle: E\ngate: full\nevidence_worker: conv_x\n---\n\nbody')
    upgradeProjectBoard(root, { nowMs: NOW })
    const after = readFileSync(cardFile('ev'), 'utf8')
    expect(after).toContain('gate: full')
    expect(after).toContain('evidence_worker: conv_x')
  })

  test('backs up every lane file before touching anything', () => {
    lane('open', 'a', '---\ntitle: A\n---\n\nbody')
    const r = upgradeProjectBoard(root, { nowMs: NOW })
    expect(r.backedUp).toBe(1)
    expect(existsSync(join(r.backupDir as string, 'open/a.md'))).toBe(true)
  })

  test('--no-backup skips the copy', () => {
    lane('open', 'a', '---\ntitle: A\n---\n')
    const r = upgradeProjectBoard(root, { backup: false, nowMs: NOW })
    expect(r.backupDir).toBeUndefined()
    expect(r.backedUp).toBe(0)
  })

  test('dry run reports without touching the disk', () => {
    lane('open', 'a', '---\ntitle: A\n---\n')
    const r = upgradeProjectBoard(root, { dryRun: true, nowMs: NOW })
    expect(r.legacy.map(c => c.slug)).toEqual(['a'])
    expect(r.moved).toEqual([])
    expect(existsSync(join(root, '.rclaude/project/open/a.md'))).toBe(true)
    expect(existsSync(cardFile('a'))).toBe(false)
  })

  test('reports collisions and keeps the card furthest along the pipeline', () => {
    lane('open', 'clash', '---\ntitle: early\n---\n\nearly')
    lane('done', 'clash', '---\ntitle: late\n---\n\nlate')

    const r = upgradeProjectBoard(root, { nowMs: NOW })
    expect(r.collisions).toEqual([{ slug: 'clash', lanes: ['open', 'done'] }])
    expect(getProjectTask(root, 'clash')?.body).toBe('late')
    // The loser is left where it lies rather than silently deleted.
    expect(existsSync(join(root, '.rclaude/project/open/clash.md'))).toBe(true)
  })

  test('is idempotent -- a second run moves nothing and still succeeds', () => {
    lane('open', 'a', '---\ntitle: A\n---\n\nbody')
    upgradeProjectBoard(root, { nowMs: NOW })
    const second = upgradeProjectBoard(root, { nowMs: NOW })
    expect(second.legacy).toEqual([])
    expect(second.moved).toEqual([])
    expect(second.failures).toEqual([])
    expect(listProjectTasks(root)).toHaveLength(1)
  })

  test('removes the lane directories it emptied', () => {
    lane('open', 'a', '---\ntitle: A\n---\n')
    const r = upgradeProjectBoard(root, { nowMs: NOW })
    expect(r.lanesRemoved).toContain('open')
    expect(existsSync(join(root, '.rclaude/project/open'))).toBe(false)
  })

  test('leaves non-card files in the board root alone', () => {
    mkdirSync(join(root, '.rclaude/project'), { recursive: true })
    writeFileSync(join(root, '.rclaude/project/priority.md'), 'top of mind')
    writeFileSync(join(root, '.rclaude/project/gate.conf'), 'tier2\n')
    lane('open', 'a', '---\ntitle: A\n---\n')

    upgradeProjectBoard(root, { nowMs: NOW })
    expect(readFileSync(join(root, '.rclaude/project/priority.md'), 'utf8')).toBe('top of mind')
    expect(existsSync(join(root, '.rclaude/project/gate.conf'))).toBe(true)
    expect(existsSync(cardFile('priority'))).toBe(false)
  })

  test('builds NO views farm -- the upgrade drains lanes, it does not mirror them', () => {
    lane('done', 'a', '---\ntitle: A\n---\n')
    upgradeProjectBoard(root, { nowMs: NOW })
    expect(readFileSync(cardFile('a'), 'utf8')).toContain('title: A')
    expect(existsSync(join(root, '.rclaude/project/views'))).toBe(false)
  })
})
