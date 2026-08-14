/**
 * The second write path: reshaping a value that was already on the card and
 * being read as nothing. What matters most is that a repaired value is NOT also
 * reported as broken -- the repair runs first and every check sees the card as
 * it now is.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProjectDoctor } from './project-doctor'
import { repairCardShape } from './project-doctor-shape'
import type { DoctorFinding } from './project-doctor-types'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-doctor-shape-'))
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

const DATED = 'created: 2026-01-01T00:00:00.000Z'

describe('auto-repair: reshaping a mute value', () => {
  test('the default is READ ONLY, and the mute value is reported instead', () => {
    writeCard('bare-tags', `title: T\nstatus: open\n${DATED}\ntags: infra, board`)
    const before = read('bare-tags')
    const found = runProjectDoctor(root).findings
    expect(checks(found)).toContain('card-key-type')
    expect(checks(found)).not.toContain('card-key-reshaped')
    expect(read('bare-tags')).toBe(before)
  })

  test('repair: write listifies a bare value and does NOT also report it broken', () => {
    writeCard('bare-tags', `title: T\nstatus: open\n${DATED}\ntags: infra, board`)
    const found = runProjectDoctor(root, { repair: 'write' }).findings
    expect(forCheck(found, 'card-key-reshaped')).toHaveLength(1)
    expect(forCheck(found, 'card-key-reshaped')[0].severity).toBe('info')
    // The point of repairing before checking: one fact, reported once.
    expect(checks(found)).not.toContain('card-key-type')
    expect(read('bare-tags')).toContain('tags: [infra, board]')
  })

  test('it is idempotent -- the second run is silent and the file does not move', () => {
    writeCard('bare-tags', `title: T\nstatus: open\n${DATED}\ntags: infra`)
    runProjectDoctor(root, { repair: 'write' })
    const after = read('bare-tags')
    expect(forCheck(runProjectDoctor(root, { repair: 'write' }).findings, 'card-key-reshaped')).toEqual([])
    expect(read('bare-tags')).toBe(after)
  })

  test('preview reports what it WOULD write and touches no bytes', () => {
    writeCard('bare-tags', `title: T\nstatus: open\n${DATED}\ntags: infra, board`)
    const before = read('bare-tags')
    const found = forCheck(runProjectDoctor(root, { repair: 'preview' }).findings, 'card-key-reshaped')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('would rewrite')
    expect(read('bare-tags')).toBe(before)
  })

  test("a JUDGEMENT is never repaired -- a typo'd lane stays an error", () => {
    writeCard('typo', `title: T\nstatus: in-progres\n${DATED}`)
    const found = runProjectDoctor(root, { repair: 'write' }).findings
    expect(checks(found)).toContain('card-status-invalid')
    expect(checks(found)).not.toContain('card-key-reshaped')
    expect(read('typo')).toContain('status: in-progres')
  })

  test('an unknown key is never touched, whatever shape it is in', () => {
    writeCard('open-bag', `title: T\nstatus: open\n${DATED}\nevidence_invented: a, b`)
    runProjectDoctor(root, { repair: 'write' })
    expect(read('open-bag')).toContain('evidence_invented: a, b')
  })

  test('a LINKAGE key is left to the linkage pass -- readLinkage already folds it', () => {
    writeCard('bare-refs', `title: T\nstatus: open\n${DATED}\nrefs: docs/a.md`)
    const found = runProjectDoctor(root, { repair: 'write' }).findings
    expect(checks(found)).not.toContain('card-key-reshaped')
    expect(read('bare-refs')).toContain('refs: docs/a.md')
  })

  test('both repairs compose: a card needing a reshape AND a stamp gets both', () => {
    writeCard('both', 'title: T\nstatus: open\ntags: infra')
    const found = checks(runProjectDoctor(root, { repair: 'write' }).findings)
    expect(found).toContain('card-key-reshaped')
    expect(found).toContain('card-created-stamped')
    const after = read('both')
    expect(after).toContain('tags: [infra]')
    expect(after).toMatch(/created: \d{4}-\d{2}-\d{2}T/)
  })
})

describe('the unit, without a board', () => {
  const deps = { write: () => {} }

  test('a card with no frontmatter fences is left entirely alone', () => {
    const card = { id: 'x', abs: '/nope.md', content: 'just prose\n' }
    expect(repairCardShape(card, 'write', deps)).toEqual({ findings: [], content: 'just prose\n' })
  })

  test('a failed write reports NOTHING and keeps the original bytes', () => {
    const content = `---\ntitle: T\nstatus: open\ntags: a, b\n---\n\nbody\n`
    const boom = {
      write: () => {
        throw new Error('read-only filesystem')
      },
    }
    const out = repairCardShape({ id: 'x', abs: '/nope.md', content }, 'write', boom)
    expect(out.findings).toEqual([])
    expect(out.content).toBe(content)
  })

  test('off short-circuits before anything is parsed', () => {
    const content = `---\ntags: a, b\n---\n\nbody\n`
    expect(repairCardShape({ id: 'x', abs: '/nope.md', content }, 'off', deps).findings).toEqual([])
  })
})
