import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEpicLog, readEpicLog, readEpicLogForCard, readEpicLogTail, renderEpicLogTail } from './epic-log'
import { epicLogFile, isValidEpicId, safeEpicId } from './epic-paths'
import { isOutOfGenerations, patchEpicRun, readEpicRun, startEpicRun } from './epic-run-store'

const T0 = Date.parse('2026-08-17T10:00:00.000Z')
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epic-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('epic id safety', () => {
  test('a traversal attempt is refused, not sanitised', () => {
    expect(isValidEpicId('../../etc')).toBe(false)
    expect(() => safeEpicId('../../etc')).toThrow('invalid epic id')
  })

  test('ordinary card slugs pass', () => {
    expect(isValidEpicId('werk-epic')).toBe(true)
    expect(isValidEpicId('e1')).toBe(true)
  })
})

describe('the baton', () => {
  test('an epic that has never run has an empty log, not an error', () => {
    expect(readEpicLog(root, 'e1')).toEqual([])
    expect(renderEpicLogTail([])).toContain('first generation')
  })

  test('entries append in order and survive a round trip, card id included', () => {
    appendEpicLog(root, 'e1', { kind: 'intent', convId: 'conv_1', body: 'starting' }, T0)
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'conv_1', cardId: 't1', body: 'sent t1' }, T0 + 1000)
    const log = readEpicLog(root, 'e1')
    expect(log).toHaveLength(2)
    expect(log[0].kind).toBe('intent')
    expect(log[1].cardId).toBe('t1')
    expect(log[1].body).toBe('sent t1')
  })

  test('an empty body round-trips as empty, not as the placeholder', () => {
    appendEpicLog(root, 'e1', { kind: 'intent', convId: 'conv_1', body: '   ' }, T0)
    expect(readEpicLog(root, 'e1')[0].body).toBe('')
  })

  test('an unknown kind degrades to intent rather than dropping the entry', () => {
    appendEpicLog(root, 'e1', { kind: 'nonsense' as never, convId: 'conv_1', body: 'x' }, T0)
    expect(readEpicLog(root, 'e1')[0].kind).toBe('intent')
  })

  test('a body containing a section header does not fracture the entry', () => {
    appendEpicLog(root, 'e1', { kind: 'completion', convId: 'c', body: 'see:\n## Guard Findings\nnope' }, T0)
    const log = readEpicLog(root, 'e1')
    expect(log).toHaveLength(1)
    expect(log[0].body).toContain('Guard Findings')
  })

  test('garbage between entries is skipped, the good entries still parse', () => {
    appendEpicLog(root, 'e1', { kind: 'intent', convId: 'c', body: 'first' }, T0)
    writeFileSync(epicLogFile(root, 'e1'), `${'### not a real header\n\njunk\n'}`, { flag: 'a' })
    appendEpicLog(root, 'e1', { kind: 'merge', convId: 'c', body: 'second' }, T0 + 1)
    const kinds = readEpicLog(root, 'e1').map(e => e.kind)
    expect(kinds).toContain('intent')
    expect(kinds).toContain('merge')
  })

  test('the tail is the LAST n entries, oldest first', () => {
    for (let i = 0; i < 5; i++) {
      appendEpicLog(root, 'e1', { kind: 'intent', convId: 'c', body: `entry ${i}` }, T0 + i)
    }
    const tail = readEpicLogTail(root, 'e1', 2)
    expect(tail.map(e => e.body)).toEqual(['entry 3', 'entry 4'])
  })

  test('a tail longer than the log returns the whole log', () => {
    appendEpicLog(root, 'e1', { kind: 'intent', convId: 'c', body: 'only' }, T0)
    expect(readEpicLogTail(root, 'e1', 50)).toHaveLength(1)
  })

  test('per-card history filters to that card', () => {
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'c', cardId: 't1', body: 'a' }, T0)
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'c', cardId: 't2', body: 'b' }, T0 + 1)
    appendEpicLog(root, 'e1', { kind: 'verdict', convId: 'c', cardId: 't1', body: 'c' }, T0 + 2)
    expect(readEpicLogForCard(root, 'e1', 't1').map(e => e.body)).toEqual(['a', 'c'])
  })
})

describe('the run artifact', () => {
  test('an unstarted epic reads as null', () => {
    expect(readEpicRun(root, 'e1')).toBeNull()
  })

  test('starting writes defaults that survive a read', () => {
    startEpicRun(root, { epicId: 'e1', project: 'claude://s/p' }, T0)
    const run = readEpicRun(root, 'e1')
    expect(run?.status).toBe('armed')
    expect(run?.cadence).toBe('now')
    expect(run?.target).toBe('merged')
    expect(run?.concurrency).toBe(3)
    expect(run?.gen).toBe(0)
  })

  test('cadence is a MODE -- the same engine takes either value', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p', cadence: 'window' }, T0)
    expect(readEpicRun(root, 'e1')?.cadence).toBe('window')
    startEpicRun(root, { epicId: 'e1', project: 'p', cadence: 'now' }, T0 + 1)
    expect(readEpicRun(root, 'e1')?.cadence).toBe('now')
  })

  test('re-arming RESUMES: the generation counter is never reset', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { gen: 12, status: 'paused' }, T0 + 1)
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0 + 2)
    const run = readEpicRun(root, 'e1')
    expect(run?.gen).toBe(12)
    expect(run?.status).toBe('armed')
    expect(run?.dryGens).toBe(0)
  })

  test('a patch merges and leaves absent fields alone', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p', concurrency: 5 }, T0)
    patchEpicRun(root, 'e1', { gen: 3 }, T0 + 1)
    const run = readEpicRun(root, 'e1')
    expect(run?.gen).toBe(3)
    expect(run?.concurrency).toBe(5)
  })

  test('patching an epic that never started is null, not a silent create', () => {
    expect(patchEpicRun(root, 'ghost', { gen: 1 }, T0)).toBeNull()
  })

  test('the digest is body prose and round-trips', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { digest: 'Two cards left; both waiting on the schema card.' }, T0 + 1)
    expect(readEpicRun(root, 'e1')?.digest).toContain('schema card')
  })

  test('the generation ceiling is the runaway backstop', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p', maxGens: 3 }, T0)
    patchEpicRun(root, 'e1', { gen: 2 }, T0 + 1)
    expect(isOutOfGenerations(readEpicRun(root, 'e1')!)).toBe(false)
    patchEpicRun(root, 'e1', { gen: 3 }, T0 + 2)
    expect(isOutOfGenerations(readEpicRun(root, 'e1')!)).toBe(true)
  })

  test('a junk value falls back to the default instead of poisoning the run', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { status: 'exploded' as never, cadence: 'whenever' as never }, T0 + 1)
    const run = readEpicRun(root, 'e1')
    expect(run?.status).toBe('armed')
    expect(run?.cadence).toBe('now')
  })
})
