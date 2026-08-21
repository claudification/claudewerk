import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acknowledgedCardIds, appendEpicLog, readEpicLog, readEpicLogForCard, renderEpicLogTail } from './epic-log'
import { epicDir, epicLogFile } from './epic-paths'

let root: string
const T0 = Date.parse('2026-08-21T10:00:00.000Z')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epic-scope-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function headers(root: string, epicId: string): string[] {
  return readFileSync(epicLogFile(root, epicId), 'utf8')
    .split('\n')
    .filter(l => l.startsWith('### '))
}

describe('the tag slot carries the epic as well as the card', () => {
  test('an entry written for epic E card C round-trips to both ids', () => {
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c1', cardId: 't1', body: 'APPROVED' }, T0)
    const [entry] = readEpicLog(root, 'e1')
    expect(entry).toMatchObject({ epicId: 'e1', cardId: 't1', kind: 'verdict' })
  })

  test('the composed token is what actually lands on disk', () => {
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c1', cardId: 't1', body: 'APPROVED' }, T0)
    expect(headers(root, 'e1')[0]).toBe('### 2026-08-21T10:00:00.000Z verdict [c1] e1/t1')
  })

  /** The pivot's shape: one baton, entries from several epics. */
  test('an entry can name an epic other than the log it lands in', () => {
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'c1', epicId: 'e2', cardId: 't1', body: '' }, T0)
    expect(readEpicLog(root, 'e1')[0]).toMatchObject({ epicId: 'e2', cardId: 't1' })
  })

  test('an entry with no card still carries its epic', () => {
    appendEpicLog(root, 'e1', { kind: 'intent', convId: 'c1', body: 'planning' }, T0)
    const [entry] = readEpicLog(root, 'e1')
    expect(entry.epicId).toBe('e1')
    expect(entry.cardId).toBeUndefined()
  })

  test('the prompt block a generation is handed re-parses to the same entries', () => {
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'c1', cardId: 't1', body: 'go' }, T0)
    appendEpicLog(root, 'e1', { kind: 'intent', convId: 'c1', body: 'thinking' }, T0 + 1000)
    const rendered = renderEpicLogTail(readEpicLog(root, 'e1'))
    mkdirSync(epicDir(root, 'e2'), { recursive: true })
    writeFileSync(epicLogFile(root, 'e2'), `# Epic Baton\n\n${rendered}\n`, 'utf8')
    expect(readEpicLog(root, 'e2')).toEqual(readEpicLog(root, 'e1'))
  })
})

describe('the readers that compare a card id stay card-scoped', () => {
  test("a card's own history is not swallowed by the composed tag", () => {
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'c1', cardId: 't1', body: 'a' }, T0)
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c1', cardId: 't1', body: 'b' }, T0 + 1000)
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c1', cardId: 't2', body: 'c' }, T0 + 2000)
    expect(readEpicLogForCard(root, 'e1', 't1').map(e => e.body)).toEqual(['a', 'b'])
  })

  test('a card history is scoped to the epic asked for, not just the card id', () => {
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c1', cardId: 't1', body: 'mine' }, T0)
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c1', epicId: 'e2', cardId: 't1', body: 'theirs' }, T0 + 1000)
    expect(readEpicLogForCard(root, 'e1', 't1').map(e => e.body)).toEqual(['mine'])
    expect(readEpicLogForCard(root, 'e2', 't1')).toEqual([])
  })

  /** THE WAKE-LOOP GUARD: a settle that reads as unacknowledged wakes the
   *  overseer every beat, which is how epic-the-wall burned five generations. */
  test('acknowledgedCardIds still folds bare card ids, not composed tokens', () => {
    appendEpicLog(root, 'e1', { kind: 'completion', convId: 'broker', cardId: 't1', body: 'settled' }, T0)
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c1', cardId: 't2', body: 'APPROVED' }, T0 + 1000)
    expect(acknowledgedCardIds(readEpicLog(root, 'e1')).sort()).toEqual(['t1', 't2'])
  })

  test('the machine acknowledgement is still written at most once per card', () => {
    const first = appendEpicLog(root, 'e1', { kind: 'completion', convId: 'broker', cardId: 't1', body: 'one' }, T0)
    const again = appendEpicLog(root, 'e1', { kind: 'completion', convId: 'broker', cardId: 't1', body: 'two' }, T0 + 1)
    expect(again).toEqual(first)
    expect(readEpicLog(root, 'e1')).toHaveLength(1)
  })

  /** Same card id, different epic, is a DIFFERENT settle -- deduping across the
   *  two would silently drop one epic's acknowledgement in a shared baton. */
  test('the dedupe is per epic, not per card id alone', () => {
    appendEpicLog(root, 'e1', { kind: 'completion', convId: 'broker', cardId: 't1', body: 'one' }, T0)
    appendEpicLog(root, 'e1', { kind: 'completion', convId: 'broker', epicId: 'e2', cardId: 't1', body: 'two' }, T0 + 1)
    expect(readEpicLog(root, 'e1')).toHaveLength(2)
  })
})

/**
 * A REAL BATON, not a hand-written one.
 *
 * `__fixtures__/legacy-epic-baton-the-wall.md` is a verbatim prefix of
 * `.rclaude/project/epics/epic-the-wall/log.md` as it stood on 2026-08-21 (38
 * sections, every tag a bare card id, written months before this file existed).
 * Refresh it with `awk 'NR<=1081' <that file> > <this fixture>`.
 *
 * The invariant is not "it parses" -- it is that the READS THE BEAT DEPENDS ON
 * return exactly what they returned before the tag was composed. A half-done
 * split does not error; it makes every settled card look unacknowledged forever.
 */
describe('a legacy baton reads the same as it always did', () => {
  const FIXTURE = join(import.meta.dir, '__fixtures__', 'legacy-epic-baton-the-wall.md')
  const EPIC = 'epic-the-wall'

  /** The OLD semantics, reimplemented here on purpose: the tag IS the card id,
   *  and there is no epic. Comparing against the shipped reader would only prove
   *  the reader agrees with itself. */
  function legacyParse(file: string): Array<{ kind: string; cardId?: string }> {
    const HEADER = /^(\S+)\s+(\S+)\s+\[([^\]]*)\](?:\s+(\S+))?/
    const out: Array<{ kind: string; cardId?: string }> = []
    for (const sec of readFileSync(file, 'utf8').split(/^### /m).slice(1)) {
      const nl = sec.indexOf('\n')
      const head = (nl === -1 ? sec : sec.slice(0, nl)).match(HEADER)
      if (!head) continue
      out.push({ kind: head[2], ...(head[4] ? { cardId: head[4] } : {}) })
    }
    return out
  }

  function seedFromFixture(): void {
    mkdirSync(epicDir(root, EPIC), { recursive: true })
    copyFileSync(FIXTURE, epicLogFile(root, EPIC))
  }

  test('every bare tag becomes that card in THIS log own epic', () => {
    seedFromFixture()
    const entries = readEpicLog(root, EPIC)
    const legacy = legacyParse(FIXTURE)
    expect(entries).toHaveLength(legacy.length)
    expect(entries.length).toBeGreaterThan(30)
    for (const [i, e] of entries.entries()) {
      expect(e.epicId).toBe(EPIC)
      expect(e.cardId).toBe(legacy[i].cardId as string | undefined)
    }
  })

  test('acknowledgedCardIds returns the same set before and after the change', () => {
    seedFromFixture()
    const legacyAcks = [
      ...new Set(
        legacyParse(FIXTURE)
          .filter(e => (e.kind === 'completion' || e.kind === 'verdict') && e.cardId)
          .map(e => e.cardId as string),
      ),
    ].sort()
    expect(legacyAcks.length).toBeGreaterThan(0)
    expect(acknowledgedCardIds(readEpicLog(root, EPIC)).sort()).toEqual(legacyAcks)
  })

  test('a card history read off the legacy log is still non-empty', () => {
    seedFromFixture()
    expect(readEpicLogForCard(root, EPIC, 'wall-surface-shell').length).toBeGreaterThan(0)
  })

  /** Appending to a legacy log composes the NEW entry without disturbing the old
   *  ones -- the two shapes coexist in one file for as long as the file lives. */
  test('a composed append lands beside untouched legacy entries', () => {
    seedFromFixture()
    const before = readEpicLog(root, EPIC)
    appendEpicLog(root, EPIC, { kind: 'verdict', convId: 'c1', cardId: 'wall-filter-bus', body: 'APPROVED' }, T0)
    const after = readEpicLog(root, EPIC)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after[after.length - 1]).toMatchObject({ epicId: EPIC, cardId: 'wall-filter-bus' })
    expect(headers(root, EPIC).pop()).toContain(`${EPIC}/wall-filter-bus`)
  })
})
