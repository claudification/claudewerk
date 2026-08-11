import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectTask } from '../shared/project-store'
import { autoUpgradeBoard, resetAutoUpgradeState } from './board-auto-upgrade'

let root: string
const logs: string[] = []
const log = (m: string) => {
  logs.push(m)
}
const NOW = Date.parse('2026-08-12T01:00:00.000Z')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'auto-upgrade-'))
  logs.length = 0
  resetAutoUpgradeState()
  delete process.env.CLAUDWERK_BOARD_AUTOUPGRADE
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.CLAUDWERK_BOARD_AUTOUPGRADE
})

function lane(status: string, id: string) {
  mkdirSync(join(root, '.rclaude/project', status), { recursive: true })
  writeFileSync(join(root, '.rclaude/project', status, `${id}.md`), `---\ntitle: ${id}\n---\n\nbody`)
}
const laneFile = (status: string, id: string) => join(root, '.rclaude/project', status, `${id}.md`)
const cardFile = (id: string) => join(root, '.rclaude/project/cards', `${id}.md`)

describe('autoUpgradeBoard', () => {
  test('drains legacy lanes on first watch and logs what it did', () => {
    lane('open', 'a')
    lane('done', 'b')

    autoUpgradeBoard(root, log, NOW)

    expect(existsSync(cardFile('a'))).toBe(true)
    expect(existsSync(laneFile('open', 'a'))).toBe(false)
    expect(getProjectTask(root, 'b')?.status).toBe('done')
    expect(logs.join('\n')).toContain('moved 2/2 card(s) into cards/')
  })

  test('runs once per project per process', () => {
    lane('open', 'a')
    autoUpgradeBoard(root, log, NOW)
    lane('open', 'later') // arrives after the sweep
    autoUpgradeBoard(root, log, NOW)

    expect(logs.filter(l => l.includes('moved'))).toHaveLength(1)
    // The straggler is NOT swept, but it is still fully readable + writable.
    expect(existsSync(laneFile('open', 'later'))).toBe(true)
    expect(getProjectTask(root, 'later')?.status).toBe('open')
  })

  test('an already-migrated board is silent', () => {
    autoUpgradeBoard(root, log, NOW)
    expect(logs).toHaveLength(0)
  })

  test('CLAUDWERK_BOARD_AUTOUPGRADE=0 leaves the board alone', () => {
    process.env.CLAUDWERK_BOARD_AUTOUPGRADE = '0'
    lane('open', 'a')

    autoUpgradeBoard(root, log, NOW)

    expect(existsSync(laneFile('open', 'a'))).toBe(true)
    expect(existsSync(cardFile('a'))).toBe(false)
    expect(logs).toHaveLength(0)
    // Still readable -- disabling the sweep must not cost visibility.
    expect(getProjectTask(root, 'a')?.status).toBe('open')
  })

  test('collisions are reported, not swallowed', () => {
    lane('open', 'clash')
    lane('done', 'clash')

    autoUpgradeBoard(root, log, NOW)

    expect(logs.join('\n')).toContain('COLLISION clash in [open,done] -- kept "done"')
  })

  test('a broken board never takes the watch down', () => {
    const missing = join(root, 'does-not-exist')
    expect(() => autoUpgradeBoard(missing, log, NOW)).not.toThrow()
  })
})
