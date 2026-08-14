import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CardStat, type CreatedStampDeps, stampMissingCreated } from './project-doctor-created'

const NOW = Date.parse('2026-08-14T12:00:00.000Z')
const BIRTH = Date.parse('2026-08-01T00:00:00.000Z')
const CTIME = Date.parse('2026-08-05T00:00:00.000Z')
const MTIME = Date.parse('2026-08-09T00:00:00.000Z')

let dir: string
let written: Array<{ abs: string; content: string }>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-created-'))
  written = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deps(stat: Partial<CardStat> | null = {}): CreatedStampDeps {
  return {
    nowMs: NOW,
    stat: () => (stat === null ? null : { birthtimeMs: BIRTH, ctimeMs: CTIME, mtimeMs: MTIME, ...stat }),
    write: (abs, content) => {
      written.push({ abs, content })
      writeFileSync(abs, content, 'utf8')
    },
  }
}

/** A card on disk plus the shape the doctor hands to the stamper. */
function card(id: string, content: string) {
  const abs = join(dir, `${id}.md`)
  writeFileSync(abs, content, 'utf8')
  return { id, abs, content }
}

const NO_CREATED = '---\ntitle: T\nstatus: open\n---\n\nbody\n'
const keyOf = (line: string): string => line.split(':')[0]

describe('which stat wins', () => {
  test('birthtime is preferred -- it is the only one that really means creation', () => {
    const found = stampMissingCreated(card('c', NO_CREATED), 'write', deps())
    expect(found).toHaveLength(1)
    expect(found[0].check).toBe('card-created-stamped')
    expect(found[0].severity).toBe('info')
    expect(found[0].problem).toContain('birthtime')
    expect(readFileSync(join(dir, 'c.md'), 'utf8')).toContain(`created: ${new Date(BIRTH).toISOString()}`)
  })

  test('falls back to ctime when the filesystem reports no birthtime', () => {
    const found = stampMissingCreated(card('c', NO_CREATED), 'write', deps({ birthtimeMs: 0 }))
    expect(found[0].problem).toContain('ctime')
    expect(found[0].problem).toContain(new Date(CTIME).toISOString())
  })

  test('falls back to mtime when birthtime and ctime are both nonsense', () => {
    const found = stampMissingCreated(
      card('c', NO_CREATED),
      'write',
      deps({ birthtimeMs: 0, ctimeMs: NOW + 999 * 24 * 3600_000 }),
    )
    expect(found[0].problem).toContain('mtime')
    expect(found[0].problem).toContain(new Date(MTIME).toISOString())
  })

  test('the INFO line says it is a filesystem guess, not a recovered fact', () => {
    const found = stampMissingCreated(card('c', NO_CREATED), 'write', deps())
    expect(`${found[0].problem} ${found[0].remedy}`.toLowerCase()).toContain('guess')
  })

  test('no plausible stat at all -- stamp nothing rather than write a lie', () => {
    const stats = { birthtimeMs: 0, ctimeMs: 0, mtimeMs: 0 }
    expect(stampMissingCreated(card('c', NO_CREATED), 'write', deps(stats))).toEqual([])
    expect(written).toEqual([])
  })

  test('an unstattable file is left alone', () => {
    expect(stampMissingCreated(card('c', NO_CREATED), 'write', deps(null))).toEqual([])
    expect(written).toEqual([])
  })
})

describe('what counts as missing', () => {
  const stampsIt = (frontmatter: string) =>
    stampMissingCreated(card('c', `---\n${frontmatter}\n---\n\nbody\n`), 'write', deps())

  test('no key at all', () => {
    expect(stampsIt('title: T')).toHaveLength(1)
  })

  test('an empty value', () => {
    expect(stampsIt('title: T\ncreated:')).toHaveLength(1)
  })

  test('the literal string `undefined` -- six live cards carry exactly this', () => {
    expect(stampsIt('title: T\ncreated: undefined')).toHaveLength(1)
    expect(written[0].content).not.toContain('created: undefined')
  })

  test('anything else that is not a date', () => {
    expect(stampsIt('title: T\ncreated: soon')).toHaveLength(1)
  })

  test('a date in a DIFFERENT format is left alone -- normalising is a separate job', () => {
    expect(stampsIt('title: T\ncreated: 2026-08-11')).toEqual([])
    expect(written).toEqual([])
  })

  test('a card with no frontmatter block is skipped -- card-no-frontmatter owns that', () => {
    const found = stampMissingCreated(card('c', 'just a body, no fences\n'), 'write', deps())
    expect(found).toEqual([])
    expect(written).toEqual([])
  })

  test('an unreadable card is skipped -- card-unreadable owns that', () => {
    const found = stampMissingCreated({ id: 'c', abs: join(dir, 'c.md'), content: null }, 'write', deps())
    expect(found).toEqual([])
    expect(written).toEqual([])
  })
})

describe('repair modes', () => {
  test('off writes nothing and reports nothing -- the check IS the repair', () => {
    expect(stampMissingCreated(card('c', NO_CREATED), 'off', deps())).toEqual([])
    expect(written).toEqual([])
  })

  test('preview reports what it WOULD do, and touches no file', () => {
    const found = stampMissingCreated(card('c', NO_CREATED), 'preview', deps())
    expect(found).toHaveLength(1)
    expect(found[0].check).toBe('card-created-stamped')
    expect(found[0].problem).toContain('would stamp')
    expect(written).toEqual([])
    expect(readFileSync(join(dir, 'c.md'), 'utf8')).toBe(NO_CREATED)
  })
})

describe('idempotence', () => {
  test('a second run stamps nothing and reports nothing', () => {
    const target = card('c', NO_CREATED)
    expect(stampMissingCreated(target, 'write', deps())).toHaveLength(1)

    const after = readFileSync(target.abs, 'utf8')
    const second = stampMissingCreated({ ...target, content: after }, 'write', deps())
    expect(second).toEqual([])
    expect(written).toHaveLength(1)
    expect(readFileSync(target.abs, 'utf8')).toBe(after)
  })
})

describe('the write goes through the card writer', () => {
  const RICH = [
    '---',
    'title: T',
    'status: open',
    'priority: high',
    'tags: [a, b]',
    'evidence_branch: worktree-x',
    'evidence_commits: [abc123]',
    'gate: strict',
    '---',
    '',
    'the body\n',
  ].join('\n')

  test('PRESERVE-UNKNOWN-KEYS holds -- the gate evidence survives', () => {
    stampMissingCreated(card('c', RICH), 'write', deps())
    const out = written[0].content
    expect(out).toContain('evidence_branch: worktree-x')
    expect(out).toContain('evidence_commits: [abc123]')
    expect(out).toContain('gate: strict')
  })

  test('ORDERED_KEYS holds -- created lands after tags, before the unknown keys', () => {
    stampMissingCreated(card('c', RICH), 'write', deps())
    const keys = written[0].content.split('\n---')[0].split('\n').slice(1).map(keyOf)
    const expected = 'title status priority tags created evidence_branch evidence_commits gate'
    expect(keys).toEqual(expected.split(' '))
  })

  test('the body is untouched', () => {
    stampMissingCreated(card('c', RICH), 'write', deps())
    expect(written[0].content.endsWith('the body\n')).toBe(true)
  })

  test('a failed write reports nothing -- no finding claims a stamp that did not land', () => {
    const boom: CreatedStampDeps = {
      ...deps(),
      write: () => {
        throw new Error('EACCES')
      },
    }
    expect(stampMissingCreated(card('c', NO_CREATED), 'write', boom)).toEqual([])
  })
})
