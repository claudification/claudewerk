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

describe('layout', () => {
  test('a leftover symlink farm is reported, with the rm command', () => {
    writeCard('c', 'title: C\nstatus: open')
    linkView('open', 'c') // a farm this board still has from before the deletion
    const found = forCheck(runProjectDoctor(root).findings, 'views-leftover')
    expect(found).toHaveLength(1)
    expect(found[0].remedy).toContain('rm -rf')
  })

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
    writeFileSync(join(boardDir(), 'priority.md'), 'notes\n', 'utf8')
    writeFileSync(join(boardDir(), 'gate.conf'), 'mode=off\n', 'utf8')
    mkdirSync(join(boardDir(), 'quests'), { recursive: true })
    mkdirSync(join(boardDir(), '.upgrade-backup-123'), { recursive: true })
    expect(runProjectDoctor(root).findings).toEqual([])
  })

  test('non-cards inside cards/ are reported', () => {
    writeCard('c', 'title: C\nstatus: open')
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

describe('linkage verbs reach the report', () => {
  test('a forward reference on ANY verb is a warning, never an error', () => {
    writeCard('e', 'title: E\nstatus: open\ntags: [epic]')
    writeCard('a', 'title: A\nstatus: open\nepic: not-written\ndepends_on: [also-not]\nrelates_to: [nor-this]')
    const { findings } = runProjectDoctor(root)
    expect(checks(findings).toSorted()).toEqual(['epic-depends-missing', 'epic-orphan', 'relates-missing'])
    expect(findings.every(f => f.severity === 'warning')).toBe(true)
  })

  test('blocked_by resolves as depends_on -- the alias is not merely tolerated', () => {
    writeCard('a', 'title: A\nstatus: open\nblocked_by: [ghost]')
    expect(forCheck(runProjectDoctor(root).findings, 'epic-depends-missing')).toHaveLength(1)
  })

  test('blocked_by pointing at a real card is completely clean', () => {
    writeCard('a', 'title: A\nstatus: open\nblocked_by: [b]')
    writeCard('b', 'title: B\nstatus: open')
    expect(checks(runProjectDoctor(root).findings).filter(c => c !== 'linkage-alias')).toEqual([])
  })

  test('a depends_on ring is an ERROR -- that one the board cannot resolve', () => {
    writeCard('a', 'title: A\nstatus: open\ndepends_on: [b]')
    writeCard('b', 'title: B\nstatus: open\ndepends_on: [a]')
    const found = forCheck(runProjectDoctor(root).findings, 'depends-cycle')
    expect(found).toHaveLength(2)
    expect(found.every(f => f.severity === 'error')).toBe(true)
  })

  test('a mistyped verb surfaces instead of vanishing into the frontmatter bag', () => {
    writeCard('a', 'title: A\nstatus: open\ndepends-on: [b]')
    writeCard('b', 'title: B\nstatus: open')
    const found = forCheck(runProjectDoctor(root).findings, 'linkage-verb-typo')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('depends_on')
  })

  test('the gate machinery keeps its open frontmatter bag', () => {
    writeCard('a', 'title: A\nstatus: open\nevidence_commits: [abc123]\ngate: green\ntest_cmd: bun test')
    expect(runProjectDoctor(root).findings).toEqual([])
  })
})

describe('illustration is not link rot', () => {
  test('a card path inside backticks or a fence is an EXAMPLE, not a link', () => {
    writeCard(
      'explains-the-board',
      'title: Docs\nstatus: open',
      [
        'Create one with `.rclaude/project/cards/my-task.md`.',
        '',
        '```',
        'Write .rclaude/project/cards/another-example.md',
        '```',
      ].join('\n'),
    )
    expect(forCheck(runProjectDoctor(root).findings, 'link-rot')).toHaveLength(0)
  })

  test('a real markdown link is still caught right next to an example', () => {
    writeCard(
      'mixed',
      'title: Mixed\nstatus: open',
      'example `.rclaude/project/cards/fake.md` but [this](.rclaude/project/cards/really-gone.md) is a link',
    )
    const found = forCheck(runProjectDoctor(root).findings, 'link-rot')
    expect(found).toHaveLength(1)
    expect(found[0].problem).toContain('really-gone')
  })
})
