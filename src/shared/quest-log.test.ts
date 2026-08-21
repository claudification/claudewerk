import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLogEntry, readLog } from './quest-log'
import { logFile } from './quest-paths'
import { createQuest } from './quest-store'

/**
 * THE TRIPWIRE ON THE SHARED HEADER FORMAT -- the reason an epic's extra id is
 * COMPOSED into one token instead of the header being widened to two.
 *
 * `md-section-log.ts` exists because this module and `epic-log.ts` had the same
 * parser twice, and its own header says a divergence between them would be
 * SILENT: the reader skips sections it no longer recognises, so a baton would
 * appear to have FEWER ENTRIES rather than fail. A quest header has NO tag slot
 * in use at all, so a second token added for epics would rewrite this parser to
 * buy something quests never asked for.
 *
 * These tests assert the exact bytes of a quest header line. Behavioural
 * coverage of append/read lives in `quest-store.test.ts` and is not repeated
 * here -- what is here is only what would have to break loudly if the shared
 * format ever moved.
 */

let root: string
const T0 = Date.parse('2026-08-21T10:00:00.000Z')

function seed(): void {
  createQuest(root, { project: 'p', goal: 'g', petname: 'floppy-panda' }, T0 - 1000)
}

function headers(): string[] {
  return readFileSync(logFile(root, 'floppy-panda'), 'utf8')
    .split('\n')
    .filter(l => l.startsWith('### '))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quest-log-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the quest header format is untouched by the epic tag', () => {
  test('a header line is ts + kind + [convId] and nothing else', () => {
    seed()
    appendLogEntry(root, 'floppy-panda', { kind: 'intent', convId: 'conv_a', body: 'starting' }, T0)
    expect(headers()).toEqual(['### 2026-08-21T10:00:00.000Z intent [conv_a]'])
  })

  test('a quest entry carries no card and no epic -- that vocabulary is the epic layer only', () => {
    seed()
    appendLogEntry(root, 'floppy-panda', { kind: 'intent', convId: 'conv_a', body: 'x' }, T0)
    const [entry] = readLog(root, 'floppy-panda')
    expect(Object.keys(entry).sort()).toEqual(['body', 'convId', 'kind', 'ts'])
  })

  /** A slash in a quest's own fields must not start meaning something. */
  test('a convId that contains a separator is still one opaque conv id', () => {
    seed()
    appendLogEntry(root, 'floppy-panda', { kind: 'intent', convId: 'host/conv_a', body: 'x' }, T0)
    expect(headers()).toEqual(['### 2026-08-21T10:00:00.000Z intent [host/conv_a]'])
    expect(readLog(root, 'floppy-panda')[0].convId).toBe('host/conv_a')
  })
})
