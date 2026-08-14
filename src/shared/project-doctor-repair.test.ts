/**
 * The doctor's ONE write path, end to end. The unit-level behaviour of the
 * stamp lives in project-doctor-created.test.ts; what is proved here is the
 * wiring: that `repair` defaults to off, that turning it on writes real files,
 * and that it leaves the other fifteen read-only checks alone.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProjectDoctor } from './project-doctor'
import type { DoctorFinding } from './project-doctor-types'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-doctor-repair-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const cardsDir = () => join(root, '.rclaude', 'project', 'cards')

function writeCard(id: string, frontmatter: string, body = 'a body'): void {
  mkdirSync(cardsDir(), { recursive: true })
  writeFileSync(join(cardsDir(), `${id}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
}

const read = (id: string) => readFileSync(join(cardsDir(), `${id}.md`), 'utf8')
const checks = (findings: DoctorFinding[]): string[] => findings.map(f => f.check)
const forCheck = (findings: DoctorFinding[], check: string) => findings.filter(f => f.check === check)

describe('auto-repair: stamping a missing created:', () => {
  test('the default is READ ONLY -- a library caller never gets a surprise write', () => {
    writeCard('no-date', 'title: T\nstatus: open')
    const before = read('no-date')
    expect(checks(runProjectDoctor(root).findings)).not.toContain('card-created-stamped')
    expect(read('no-date')).toBe(before)
  })

  test('repair: write stamps the card and reports it as INFO, once', () => {
    writeCard('no-date', 'title: T\nstatus: open')
    const found = forCheck(runProjectDoctor(root, { repair: 'write' }).findings, 'card-created-stamped')
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('info')

    const after = read('no-date')
    expect(after).toMatch(/created: \d{4}-\d{2}-\d{2}T/)
    // Idempotent: the second run is silent and the file does not move again.
    expect(forCheck(runProjectDoctor(root, { repair: 'write' }).findings, 'card-created-stamped')).toEqual([])
    expect(read('no-date')).toBe(after)
  })

  test('repair: preview reports the same finding but writes nothing', () => {
    writeCard('no-date', 'title: T\nstatus: open')
    const before = read('no-date')
    const found = forCheck(runProjectDoctor(root, { repair: 'preview' }).findings, 'card-created-stamped')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('would stamp')
    expect(read('no-date')).toBe(before)
  })

  test('a card that already has a created: is left alone entirely', () => {
    writeCard('dated', 'title: T\nstatus: open\ncreated: 2026-01-01T00:00:00.000Z')
    const before = read('dated')
    expect(checks(runProjectDoctor(root, { repair: 'write' }).findings)).not.toContain('card-created-stamped')
    expect(read('dated')).toBe(before)
  })

  test('repairing does not disturb the other checks', () => {
    writeCard('broken', 'title: T\nstatus: nonsense')
    const found = runProjectDoctor(root, { repair: 'write' }).findings
    expect(checks(found)).toContain('card-status-invalid')
    expect(checks(found)).toContain('card-created-stamped')
  })

  test('the stamp survives a card carrying keys the store knows nothing about', () => {
    writeCard('rich', 'title: T\nstatus: open\nevidence_branch: worktree-x\ngate: tier2')
    expect(forCheck(runProjectDoctor(root, { repair: 'write' }).findings, 'card-created-stamped')).toHaveLength(1)
    const after = read('rich')
    expect(after).toContain('evidence_branch: worktree-x')
    expect(after).toContain('gate: tier2')
    expect(after).toContain('a body')
  })
})
