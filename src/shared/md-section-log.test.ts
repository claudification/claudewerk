import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSectionLog, type RawLogSection, readSectionLog, renderLogSection } from './md-section-log'

const HEADER = '# A Baton\n\nAppend-only.\n\n'
let dir = ''
const file = () => join(dir, 'log.md')

const entry = (n: number, over: Partial<RawLogSection> = {}): RawLogSection => ({
  ts: `2026-08-22T00:00:0${n}.000Z`,
  kind: 'intent',
  convId: `conv_${n}`,
  body: `entry ${n}`,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'section-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('appendSectionLog', () => {
  test('creates the file with the header, then appends under it', () => {
    appendSectionLog(file(), HEADER, entry(1))
    const content = readFileSync(file(), 'utf8')
    expect(content.startsWith(HEADER)).toBe(true)
    expect(readSectionLog(file()).map(s => s.body)).toEqual(['entry 1'])
  })

  test('the header is written once, not once per entry', () => {
    appendSectionLog(file(), HEADER, entry(1))
    appendSectionLog(file(), HEADER, entry(2))
    expect(readFileSync(file(), 'utf8').split('# A Baton')).toHaveLength(2)
    expect(readSectionLog(file()).map(s => s.body)).toEqual(['entry 1', 'entry 2'])
  })

  test('the tag survives the round trip, and absence of one stays absent', () => {
    appendSectionLog(file(), HEADER, entry(1, { tag: 'e1/c1' }))
    appendSectionLog(file(), HEADER, entry(2))
    const [first, second] = readSectionLog(file())
    expect(first.tag).toBe('e1/c1')
    expect(second.tag).toBeUndefined()
  })

  /**
   * THE APPEND CONTRACT -- point 3 of `epic-artifact-writes-not-atomic`.
   *
   * The old shape read the whole file and wrote the whole file back, so a
   * sentinel killed mid-append lost the ENTIRE log (1.0 MB, in
   * `epic-the-wall`'s case) rather than the last entry.
   *
   * These two pin what an append means: the existing bytes are a PREFIX of the
   * result and the file grows by exactly one rendered section. They do NOT
   * distinguish an append from a rewrite -- a rewrite reproduces the same bytes
   * -- and nothing from outside the process can, since the difference only shows
   * up when the write is interrupted. The torn-tail test below is the one that
   * goes red if this ever returns to read-then-write.
   */
  test('an append does not rewrite what is already on disk', () => {
    appendSectionLog(file(), HEADER, entry(1))
    const before = readFileSync(file(), 'utf8')

    appendSectionLog(file(), HEADER, entry(2))

    const after = readFileSync(file(), 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length)).toBe(`${renderLogSection(entry(2))}\n`)
  })

  test('and the file grows by exactly the new entry', () => {
    appendSectionLog(file(), HEADER, entry(1))
    const was = statSync(file()).size
    appendSectionLog(file(), HEADER, entry(2))
    expect(statSync(file()).size).toBe(was + Buffer.byteLength(`${renderLogSection(entry(2))}\n`))
  })

  /**
   * THE TORN TAIL, AND THE ONE ENTRY IT IS ALLOWED TO COST.
   *
   * `parseSectionLog` has always skipped a section it cannot parse, so a half-
   * written last entry loses itself and nothing else -- PROVIDED the next
   * header still starts at column 0. Without the newline guard the next `### `
   * lands mid-line, `/^### /m` cannot see it, and the good entry that followed
   * the bad one disappears too.
   */
  test('a torn tail costs the torn entry and nothing after it', () => {
    appendSectionLog(file(), HEADER, entry(1))
    // Exactly what a power loss leaves: a header and half a body, no newline.
    appendFileSync(file(), '### 2026-08-22T00:00:09.000Z intent [conv_9]\n\nhalf a bo', 'utf8')

    appendSectionLog(file(), HEADER, entry(2))

    expect(readSectionLog(file()).map(s => s.body)).toEqual(['entry 1', 'half a bo', 'entry 2'])
  })

  /** ...and the guard does not fire when it is not needed: a healthy file never
   *  collects blank lines it did not ask for. */
  test('a healthy file gains no extra blank line', () => {
    appendSectionLog(file(), HEADER, entry(1))
    appendSectionLog(file(), HEADER, entry(2))
    expect(readFileSync(file(), 'utf8')).not.toContain('\n\n\n')
  })

  /** An existing log written by the OLD shape has to keep appending cleanly --
   *  every baton on disk was produced by read-then-write. */
  test('appends onto a file the old read-then-write shape produced', () => {
    writeFileSync(file(), `${HEADER}${renderLogSection(entry(1))}\n`, 'utf8')
    appendSectionLog(file(), HEADER, entry(2))
    expect(readSectionLog(file()).map(s => s.body)).toEqual(['entry 1', 'entry 2'])
  })
})

describe('readSectionLog', () => {
  test('a missing file is an empty log, not an error', () => {
    expect(existsSync(file())).toBe(false)
    expect(readSectionLog(file())).toEqual([])
  })

  test('a file with only a header parses to nothing', () => {
    writeFileSync(file(), HEADER, 'utf8')
    expect(readSectionLog(file())).toEqual([])
  })
})
