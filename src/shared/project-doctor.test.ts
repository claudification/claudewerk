import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProjectDoctor } from './project-doctor'
import type { DoctorFinding } from './project-doctor-types'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-doctor-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const boardDir = () => join(root, '.rclaude', 'project')
const cardsDir = () => join(boardDir(), 'cards')

function writeCard(id: string, frontmatter: string, body = 'a body'): void {
  mkdirSync(cardsDir(), { recursive: true })
  writeFileSync(join(cardsDir(), `${id}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
}

/** A card in a pre-migration `<lane>/` directory. */
function writeLegacyCard(lane: string, id: string, frontmatter = 'title: legacy'): void {
  const dir = join(boardDir(), lane)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.md`), `---\n${frontmatter}\n---\n\nbody\n`, 'utf8')
}

function linkView(lane: string, id: string, target = join('..', '..', 'cards', `${id}.md`)): void {
  const dir = join(boardDir(), 'views', lane)
  mkdirSync(dir, { recursive: true })
  symlinkSync(target, join(dir, `${id}.md`))
}

const checks = (findings: DoctorFinding[]): string[] => findings.map(f => f.check)
const forCheck = (findings: DoctorFinding[], check: string) => findings.filter(f => f.check === check)

describe('runProjectDoctor', () => {
  test('reports no board rather than failing', () => {
    const report = runProjectDoctor(root)
    expect(report.noBoard).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.cards).toBe(0)
  })

  test('a healthy board is completely clean', () => {
    writeCard('good-card', 'title: Good\nstatus: open')
    linkView('open', 'good-card')
    const report = runProjectDoctor(root)
    expect(report.cards).toBe(1)
    expect(report.findings).toEqual([])
  })

  test('every finding carries a remedy -- that is the deliverable', () => {
    writeCard('broken', 'title: X\nstatus: nonsense')
    for (const finding of runProjectDoctor(root).findings) {
      expect(finding.remedy.length).toBeGreaterThan(0)
      expect(finding.problem.length).toBeGreaterThan(0)
    }
  })
})

describe('card checks', () => {
  test('an invalid lane is an ERROR -- the board silently renders it as inbox', () => {
    writeCard('typo-lane', 'title: T\nstatus: in-progres')
    const found = forCheck(runProjectDoctor(root).findings, 'card-status-invalid')
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('error')
    expect(found[0].subject).toBe('typo-lane')
  })

  test('a missing lane is reported', () => {
    writeCard('no-lane', 'title: T')
    expect(checks(runProjectDoctor(root).findings)).toContain('card-status-missing')
  })

  test('a card in a legacy lane is NOT reported for a missing status key', () => {
    // Its directory IS its status -- it is undrained, not broken.
    writeLegacyCard('open', 'lane-card')
    const found = checks(runProjectDoctor(root).findings)
    expect(found).not.toContain('card-status-missing')
    expect(found).toContain('legacy-lane-cards')
  })

  test('missing title and empty body are info, not noise above it', () => {
    writeCard('bare', 'status: open', '')
    const found = checks(runProjectDoctor(root).findings)
    expect(found).toContain('card-title-missing')
    expect(found).toContain('card-empty-body')
  })

  test('a file with no frontmatter at all is reported', () => {
    mkdirSync(cardsDir(), { recursive: true })
    writeFileSync(join(cardsDir(), 'raw.md'), 'just prose, no frontmatter\n', 'utf8')
    expect(checks(runProjectDoctor(root).findings)).toContain('card-no-frontmatter')
  })
})

describe('link rot', () => {
  test('a link to a card that does not exist is reported', () => {
    writeCard('linker', 'title: L\nstatus: open', 'see [gone](.rclaude/project/cards/gone.md)')
    const found = forCheck(runProjectDoctor(root).findings, 'link-rot')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('gone')
  })

  test('a link to a card that DOES exist is silent, whatever path shape it uses', () => {
    writeCard('target-card', 'title: T\nstatus: done')
    writeCard(
      'linker',
      'title: L\nstatus: open',
      [
        '[a](.rclaude/project/cards/target-card.md)',
        '[b](.rclaude/project/done/target-card.md)', // old lane path
        '[c](.rclaude/project/views/done/target-card.md)', // view symlink path
        '[d](./.rclaude/project/cards/target-card.md)',
      ].join('\n'),
    )
    expect(forCheck(runProjectDoctor(root).findings, 'link-rot')).toHaveLength(0)
  })

  test('a card linking ITSELF is never rot', () => {
    writeCard('self', 'title: S\nstatus: open', 'see [me](.rclaude/project/cards/self.md#notes)')
    expect(forCheck(runProjectDoctor(root).findings, 'link-rot')).toHaveLength(0)
  })

  test('a rotten card path in `refs:` is caught too', () => {
    writeCard('with-refs', 'title: R\nstatus: open\nrefs: [.rclaude/project/cards/vanished.md, abc1234]')
    expect(forCheck(runProjectDoctor(root).findings, 'link-rot')).toHaveLength(1)
  })
})

describe('views farm', () => {
  test('a card with no view link is reported', () => {
    writeCard('unlinked', 'title: U\nstatus: open')
    expect(checks(runProjectDoctor(root).findings)).toContain('view-missing')
  })

  test('DUPLICATE links -- one card looking like several -- are reported', () => {
    writeCard('dupe', 'title: D\nstatus: open')
    linkView('open', 'dupe')
    linkView('done', 'dupe')
    const found = forCheck(runProjectDoctor(root).findings, 'view-duplicate')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('2 lanes')
  })

  test('a link in the wrong lane is reported', () => {
    writeCard('moved', 'title: M\nstatus: done')
    linkView('open', 'moved')
    const found = forCheck(runProjectDoctor(root).findings, 'view-wrong-lane')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('done')
  })

  test('a dangling link -- card deleted underneath it -- is reported', () => {
    writeCard('kept', 'title: K\nstatus: open')
    linkView('open', 'kept')
    linkView('open', 'deleted-card')
    expect(checks(runProjectDoctor(root).findings)).toContain('view-dangling')
  })

  test('a REAL FILE where a link belongs is reported -- edits to it are invisible', () => {
    writeCard('real', 'title: R\nstatus: open')
    linkView('open', 'real')
    const dir = join(boardDir(), 'views', 'open')
    writeFileSync(join(dir, 'impostor.md'), '---\ntitle: not a card\n---\n', 'utf8')
    const found = forCheck(runProjectDoctor(root).findings, 'view-not-a-symlink')
    expect(found).toHaveLength(1)
  })

  test('a link aimed somewhere unexpected is reported', () => {
    writeCard('aimed', 'title: A\nstatus: open')
    linkView('open', 'aimed', join('..', '..', 'cards', 'somewhere-else.md'))
    expect(checks(runProjectDoctor(root).findings)).toContain('view-wrong-target')
  })
})

describe('layout', () => {
  test('cards still in legacy lanes are reported once, with the upgrade command', () => {
    writeLegacyCard('open', 'old-one')
    writeLegacyCard('done', 'old-two')
    const found = forCheck(runProjectDoctor(root).findings, 'legacy-lane-cards')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('2 card(s)')
    expect(found[0].remedy).toContain('board:upgrade')
  })

  test('the same id in two lanes is an ERROR -- which card it is is ambiguous', () => {
    writeLegacyCard('open', 'twin')
    writeLegacyCard('done', 'twin')
    const found = forCheck(runProjectDoctor(root).findings, 'legacy-collision')
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('error')
  })

  test('a .md at the board root looks like a card and is read by nothing', () => {
    writeCard('real-card', 'title: R\nstatus: open')
    writeFileSync(join(boardDir(), 'NOTES.md'), 'not a card\n', 'utf8')
    const found = forCheck(runProjectDoctor(root).findings, 'stray-card-file')
    expect(found).toHaveLength(1)
    expect(found[0].subject).toContain('NOTES.md')
  })

  test('priority.md, gate.conf, quests/ and upgrade backups are all expected', () => {
    writeCard('c', 'title: C\nstatus: open')
    linkView('open', 'c')
    writeFileSync(join(boardDir(), 'priority.md'), 'notes\n', 'utf8')
    writeFileSync(join(boardDir(), 'gate.conf'), 'mode=off\n', 'utf8')
    mkdirSync(join(boardDir(), 'quests'), { recursive: true })
    mkdirSync(join(boardDir(), '.upgrade-backup-123'), { recursive: true })
    expect(runProjectDoctor(root).findings).toEqual([])
  })

  test('non-cards inside cards/ are reported', () => {
    writeCard('c', 'title: C\nstatus: open')
    linkView('open', 'c')
    writeFileSync(join(cardsDir(), 'notes.txt'), 'x\n', 'utf8')
    mkdirSync(join(cardsDir(), 'nested'), { recursive: true })
    const found = checks(runProjectDoctor(root).findings)
    expect(found).toContain('cards-non-card-file')
    expect(found).toContain('cards-nested-dir')
  })
})

describe('ordering', () => {
  test('errors sort ahead of warnings, warnings ahead of info', () => {
    writeCard('bad-lane', 'title: B\nstatus: not-a-lane') // error
    writeCard('untitled', 'status: open') // info
    writeCard('rotten', 'title: R\nstatus: open', '[x](.rclaude/project/cards/nope.md)') // warning
    const severities = runProjectDoctor(root).findings.map(f => f.severity)
    expect(severities.indexOf('error')).toBeLessThan(severities.indexOf('warning'))
    expect(severities.indexOf('warning')).toBeLessThan(severities.indexOf('info'))
  })
})
