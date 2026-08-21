import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEpicLog, readEpicLog, readEpicLogForCard, readEpicLogTail, renderEpicLogTail } from './epic-log'
import { epicLogFile, epicRunFile, isValidEpicId, safeEpicId } from './epic-paths'
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
    expect(run?.cadence).toEqual(['now'])
    expect(run?.target).toBe('merged')
    expect(run?.concurrency).toBe(3)
    expect(run?.gen).toBe(0)
  })

  test('cadence is a MODE -- the same engine takes either value', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p', cadence: 'window' }, T0)
    expect(readEpicRun(root, 'e1')?.cadence).toEqual(['window'])
    startEpicRun(root, { epicId: 'e1', project: 'p', cadence: 'now' }, T0 + 1)
    expect(readEpicRun(root, 'e1')?.cadence).toEqual(['now'])
  })

  /**
   * THE `when` AXIS ON DISK. A run armed before the field could hold more than
   * one gate says `cadence: window` as a bare scalar, and a parse that lost it
   * would dispatch a night run at noon -- so the scalar spelling is pinned here
   * as an INPUT, not just as something `serializeWhen` happens to emit.
   */
  test('the gate list round-trips through frontmatter, scalar or list', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p', cadence: ['window', 'queue'] }, T0)
    expect(readEpicRun(root, 'e1')?.cadence).toEqual(['window', 'queue'])
    expect(readFileSync(epicRunFile(root, 'e1'), 'utf8')).toContain('cadence: [window, queue]')

    startEpicRun(root, { epicId: 'e2', project: 'p', cadence: 'queue' }, T0)
    expect(readFileSync(epicRunFile(root, 'e2'), 'utf8')).toContain('cadence: queue')
  })

  /**
   * AN APPOINTMENT SURVIVES THE FRONTMATTER ROUND TRIP UNQUOTED.
   *
   * `at:2026-08-22T02:00:00+07:00` carries a colon, and `frontmatter.ts` takes a
   * line's key as everything before the FIRST one -- so the value has to come back
   * whole, and the quoting rules have to leave it alone (it has no `": "`, no
   * trailing colon and no leading bracket). If either half were wrong the run
   * would reload with no appointment at all and dispatch immediately, which is the
   * one direction this gate must never fail in.
   */
  test('an appointment round-trips through frontmatter, scalar and in a list', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p', cadence: '2026-08-22T02:00:00+07:00' }, T0)
    expect(readEpicRun(root, 'e1')?.cadence).toEqual(['at:2026-08-22T02:00:00+07:00'])
    expect(readFileSync(epicRunFile(root, 'e1'), 'utf8')).toContain('cadence: at:2026-08-22T02:00:00+07:00')

    startEpicRun(root, { epicId: 'e2', project: 'p', cadence: 'window,2026-08-22T02:00:00+07:00' }, T0)
    expect(readEpicRun(root, 'e2')?.cadence).toEqual(['window', 'at:2026-08-22T02:00:00+07:00'])
    expect(readFileSync(epicRunFile(root, 'e2'), 'utf8')).toContain('cadence: [window, at:2026-08-22T02:00:00+07:00]')
  })

  test('an artifact from before the axis existed keeps its gate, not the default', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    const file = epicRunFile(root, 'e1')
    // Exactly what the five run directories on disk say today.
    writeFileSync(file, readFileSync(file, 'utf8').replace('cadence: now', 'cadence: window'), 'utf8')
    expect(readEpicRun(root, 'e1')?.cadence).toEqual(['window'])
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

  /**
   * THE OTHER TWO HANDBRAKES. `maxGens` bounds how often the OVERSEER THINKS and
   * bounds nothing about what the seats underneath it burn -- on 2026-08-19 this
   * project billed $2,481 in a day with an unattended run going and nothing
   * stopped it.
   */
  describe('the spend and wall-clock ceilings', () => {
    test('are armable per run and survive a round trip to disk', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p', maxUsd: 25, maxWallClockMinutes: 60 }, T0)
      const run = readEpicRun(root, 'e1')
      expect(run?.maxUsd).toBe(25)
      expect(run?.maxWallClockMinutes).toBe(60)
    })

    test('default to something rather than to infinity', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      expect(readEpicRun(root, 'e1')).toMatchObject({ maxUsd: 100, maxWallClockMinutes: 480 })
    })

    /** A run armed before the caps existed carries neither field, and must read
     *  as CAPPED AT THE DEFAULT -- falling back to 0 would grandfather every
     *  long-lived run into the state the ceilings exist to end. */
    test('a run written before they existed reads as capped, not as uncapped', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      const file = epicRunFile(root, 'e1')
      writeFileSync(
        file,
        readFileSync(file, 'utf8')
          .split('\n')
          .filter(l => !l.startsWith('maxUsd:') && !l.startsWith('maxWallClockMinutes:'))
          .join('\n'),
        'utf8',
      )
      expect(readEpicRun(root, 'e1')).toMatchObject({ maxUsd: 100, maxWallClockMinutes: 480 })
    })

    /**
     * THE CLOCK RESTARTS, THE LEDGER DOES NOT. Wall clock measures the current
     * unattended stretch, so resuming is a new one. Spend is cumulative for the
     * life of the run and re-arming must never launder it -- a run that parked at
     * its ceiling and resumes unchanged parks again, which is the brake working.
     */
    test('re-arming clears the wall clock and keeps the spend', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      patchEpicRun(root, 'e1', { spentUsd: 31.4, startedAt: new Date(T0).toISOString(), status: 'paused' }, T0 + 1)

      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0 + 2)

      const run = readEpicRun(root, 'e1')
      expect(run?.startedAt).toBeUndefined()
      expect(run?.spentUsd).toBe(31.4)
    })

    test('and raising the ceiling on the resume is how a parked run continues', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p', maxUsd: 25 }, T0)
      patchEpicRun(root, 'e1', { spentUsd: 31.4, status: 'paused' }, T0 + 1)
      startEpicRun(root, { epicId: 'e1', project: 'p', maxUsd: 60 }, T0 + 2)
      expect(readEpicRun(root, 'e1')).toMatchObject({ maxUsd: 60, spentUsd: 31.4, status: 'armed' })
    })

    /**
     * MONEY HAS CENTS. Every other scalar on a run is a counter, so the reader
     * parsed with `parseInt` -- which truncated `31.40` to `31` on the way back
     * off disk, TOWARD ZERO, so the run under-reported what it cost and the cap
     * tripped late. Caught by the resume test above before this ever ran.
     */
    test('the ledger keeps its cents across a write and a read', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p', maxUsd: 12.75 }, T0)
      patchEpicRun(root, 'e1', { spentUsd: 0.07 }, T0 + 1)
      expect(readEpicRun(root, 'e1')).toMatchObject({ spentUsd: 0.07, maxUsd: 12.75 })
    })
  })

  test('a junk value falls back to the default instead of poisoning the run', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { status: 'exploded' as never, cadence: 'whenever' as never }, T0 + 1)
    const run = readEpicRun(root, 'e1')
    expect(run?.status).toBe('armed')
    expect(run?.cadence).toEqual(['now'])
  })
})
