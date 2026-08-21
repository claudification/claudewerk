import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-write'

let dir = ''
const target = () => join(dir, 'run.md')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  test('writes the content, creating the file', () => {
    writeFileAtomic(target(), 'hello\n')
    expect(readFileSync(target(), 'utf8')).toBe('hello\n')
  })

  test('overwrites an existing file whole', () => {
    writeFileSync(target(), 'a much longer previous version\n', 'utf8')
    writeFileAtomic(target(), 'short\n')
    expect(readFileSync(target(), 'utf8')).toBe('short\n')
  })

  /** A staging sibling left behind is litter in an artifact directory a human
   *  reads by hand. The rename is what removes it, so this also pins that the
   *  rename actually happened rather than a plain write to the target. */
  test('leaves no staging file behind on the happy path', () => {
    writeFileAtomic(target(), 'hello\n')
    expect(readdirSync(dir)).toEqual(['run.md'])
  })

  /**
   * THE WHOLE POINT, as close as a test can get to killing the process mid-write.
   *
   * `writeFileSync` on the staging path is made to fail (the path is a directory,
   * so the open is EISDIR) at exactly the moment a bare `writeFileSync` on the
   * TARGET would already have truncated it. The old file has to be intact and
   * complete afterwards -- the "either the old file or the new one, never a
   * partial" half of this card.
   */
  test('a failed write leaves the previous file intact, and throws', () => {
    const before = '---\nstatus: running\nspentUsd: 31.4\n---\n\nbody\n'
    writeFileSync(target(), before, 'utf8')
    mkdirSync(`${target()}.tmp`)

    expect(() => writeFileAtomic(target(), 'the new content')).toThrow()
    expect(readFileSync(target(), 'utf8')).toBe(before)
  })

  /** A partial staging file is garbage and does not get to survive as a sibling
   *  of the artifact. (The directory used to force the failure above cannot be
   *  unlinked, so the failure is induced with a read-only staging file instead --
   *  which root would write straight through, hence the skip.) */
  test.skipIf(process.getuid?.() === 0)('a failed write discards its own staging file', () => {
    writeFileSync(target(), 'previous\n', 'utf8')
    writeFileSync(`${target()}.tmp`, 'stale garbage\n', { mode: 0o400 })

    expect(() => writeFileAtomic(target(), 'the new content')).toThrow()
    expect(existsSync(`${target()}.tmp`)).toBe(false)
    expect(readFileSync(target(), 'utf8')).toBe('previous\n')
  })

  /**
   * The staging file is a SIBLING, never `/tmp`. `rename(2)` is atomic only
   * within one filesystem; staging somewhere else would silently degrade to a
   * copy the moment `.rclaude/` sat on its own mount, which is the exact
   * guarantee this module exists to give.
   */
  test('stages inside the target directory', () => {
    const seen: string[] = []
    writeFileSync(target(), 'previous\n', 'utf8')
    // The staging file only exists mid-call, so it is observed by making the
    // rename the thing that fails: a target that is a DIRECTORY cannot be
    // renamed over by a file, and the completed staging file is left standing.
    const asDir = join(dir, 'nested')
    mkdirSync(asDir)
    expect(() => writeFileAtomic(asDir, 'content')).toThrow()
    seen.push(...readdirSync(dir))
    expect(seen).toContain('nested.tmp')
  })
})
