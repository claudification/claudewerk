import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLease } from './epic-lease'
import { appendEpicLog, readEpicLog, readEpicLogForCard, readEpicLogTail, renderEpicLogTail } from './epic-log'
import { epicDigestFile, epicLogFile, epicRunFile, isValidEpicId, safeEpicId } from './epic-paths'
import {
  EPIC_RUN_KEYS,
  EpicRunUnreadableError,
  patchEpicRun,
  RUN_FILE_BANNER,
  readEpicRun,
  startEpicRun,
} from './epic-run-store'
import { parseFrontmatter } from './frontmatter'
import { cardPath } from './project-paths'

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
    // AND NO GENERATION. It lives on the epic card as `overseer_gen`, which is
    // what the CAS compares; a second copy here is the mirror that deadlocked
    // `epic-the-wall-ii` (see `EpicRunMeta`).
    expect(run).not.toHaveProperty('gen')
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

  /**
   * Re-arming RESUMES, and it cannot reset the generation counter for the best
   * possible reason: the counter is not in this file and `start` never opens the
   * epic card. The dry streak, which IS here, does reset -- a resumed run gets
   * its second chance back.
   */
  test('re-arming RESUMES, and writes no generation of its own', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { dryGens: 1, status: 'paused' }, T0 + 1)
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0 + 2)
    const run = readEpicRun(root, 'e1')
    expect(run?.status).toBe('armed')
    expect(run?.dryGens).toBe(0)
    expect(readFileSync(epicRunFile(root, 'e1'), 'utf8')).not.toContain('gen:')
  })

  /**
   * THE EXTEND PATH, pinned. `epic_run action=start max_gens=60` at a run that is
   * mid-flight is the ONLY way to raise a ceiling, and the card that named it
   * (`epic-extend-verb-named-start`) is a documentation job resting entirely on
   * this behaviour -- so the behaviour gets a test rather than a doc line alone.
   *
   * Two halves, and the second is the one with teeth: the ceiling moves, and the
   * WERK-MASTER LEASE does not. The generation counter lives on the epic card as
   * `overseer_gen` and `startEpicRun` never opens the card, so the card's bytes
   * must come back byte-identical. Anything else is the deadlock this whole file
   * exists to prevent, arriving through the extend verb instead of the digest.
   */
  test('start with maxGens EXTENDS a live run -- ceiling up, lease generation untouched', () => {
    const card = cardPath(root, 'e1')
    const cardBytes = [
      '---',
      'title: "the epic"',
      'status: in-progress',
      // The EPIC-CARD LEASE KEYS, untouched by the werk-* seat rename on purpose
      // -- `werk-rename-lease-keys` owns them, and half-renaming a lease loses a
      // live run's only generation counter.
      'overseer: conv_werk_master',
      'overseer_gen: 7',
      'overseer_at: 2026-08-17T10:05:00.000Z',
      '---',
      '',
      'body prose',
      '',
    ].join('\n')
    writeFileSync(card, cardBytes, 'utf8')

    startEpicRun(root, { epicId: 'e1', project: 'p', maxGens: 40 }, T0)
    // Mid-flight: running, and one dry generation already on the brake.
    patchEpicRun(root, 'e1', { status: 'running', dryGens: 1, spentUsd: 12.5 }, T0 + 1)

    startEpicRun(root, { epicId: 'e1', project: 'p', maxGens: 60 }, T0 + 2)

    const run = readEpicRun(root, 'e1')
    expect(run?.maxGens).toBe(60)
    // Spend is cumulative across a re-arm; the dry brake and the status are not.
    expect(run?.spentUsd).toBe(12.5)
    expect(run?.status).toBe('armed')
    expect(run?.dryGens).toBe(0)
    // The card is the generation's only home, and start did not go near it.
    expect(readFileSync(card, 'utf8')).toBe(cardBytes)
    expect(readLease(parseFrontmatter(readFileSync(card, 'utf8')).meta)?.gen).toBe(7)
  })

  test('a patch merges and leaves absent fields alone', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p', concurrency: 5 }, T0)
    patchEpicRun(root, 'e1', { dryGens: 3 }, T0 + 1)
    const run = readEpicRun(root, 'e1')
    expect(run?.dryGens).toBe(3)
    expect(run?.concurrency).toBe(5)
  })

  test('patching an epic that never started is null, not a silent create', () => {
    expect(patchEpicRun(root, 'ghost', { dryGens: 1 }, T0)).toBeNull()
  })

  test('the digest is body prose and round-trips', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { digest: 'Two cards left; both waiting on the schema card.' }, T0 + 1)
    expect(readEpicRun(root, 'e1')?.digest).toContain('schema card')
  })

  /**
   * THE DIGEST LIVES IN ITS OWN FILE, and this block is the whole reason:
   *
   * `run.md` used to carry engine scalars in its frontmatter AND the werk-master's
   * prose in its body, and the werk-master prompt ordered a rewrite of the second
   * every generation. There is no verb for "rewrite only the body", so the only
   * mechanism available was writing the whole file -- and the whole file carries
   * `gen`. On 2026-08-20 `epic-the-wall-ii` did exactly that: the card said
   * `overseer_gen: 11`, `run.md` said `gen: 12`, the wake quoted the run and the
   * CAS compared the card, and the run beat every 45s for hours spawning nothing
   * while every panel surface said RUNNING.
   *
   * Splitting the two files makes that class impossible rather than unlikely:
   * the writer of the prose no longer has the scalars in its hands.
   */
  describe('the digest lives beside the run, not inside it', () => {
    /** A run in the shape every artifact on disk had before the split: the prose
     *  in `run.md`'s body, no `digest.md` anywhere. */
    function writeLegacyRun(epicId: string): void {
      startEpicRun(root, { epicId, project: 'p' }, T0)
      rmSync(epicDigestFile(root, epicId))
      const file = epicRunFile(root, epicId)
      writeFileSync(file, readFileSync(file, 'utf8').replace(RUN_FILE_BANNER, 'legacy prose from gen 7'), 'utf8')
    }

    /** The RED one. An agent rewriting the digest by hand must not be able to
     *  touch a field the engine compares -- there is no frontmatter to catch. */
    test('rewriting the digest by hand cannot move the generation counter', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)

      writeFileSync(epicDigestFile(root, 'e1'), '## Board at the start of generation 12\n\nprose, 900 lines of it\n')

      const run = readEpicRun(root, 'e1')
      expect(run).not.toHaveProperty('gen')
      expect(run?.digest).toContain('generation 12')
    })

    test('a fresh run.md carries frontmatter and no digest prose', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      patchEpicRun(root, 'e1', { digest: 'Two cards left; both waiting on the schema card.' }, T0 + 1)

      const runFile = readFileSync(epicRunFile(root, 'e1'), 'utf8')
      expect(runFile).toContain('status: armed')
      expect(runFile).not.toContain('gen:')
      expect(runFile).not.toContain('schema card')
      expect(runFile).toContain(RUN_FILE_BANNER)
      expect(readFileSync(epicDigestFile(root, 'e1'), 'utf8')).toContain('schema card')
    })

    /** Every run armed before this split keeps its digest in `run.md`'s body and
     *  has no `digest.md` at all. It has to read exactly as it always did. */
    test('a run whose digest is still in run.md reads through the fallback', () => {
      writeLegacyRun('e1')
      // Sanity: the fixture really is the old shape -- frontmatter, then prose.
      expect(readFileSync(epicRunFile(root, 'e1'), 'utf8')).toContain('legacy prose')

      expect(readEpicRun(root, 'e1')?.digest).toBe('legacy prose from gen 7')
    })

    /** ...and the first write MIGRATES it, rather than dropping it on the floor.
     *  `writeRun` no longer serialises the body, so a legacy digest that was not
     *  carried across would be destroyed by the next `gen` bump. */
    test('the first write moves a legacy digest into its own file', () => {
      writeLegacyRun('e1')

      patchEpicRun(root, 'e1', { dryGens: 8 }, T0 + 1)

      expect(readFileSync(epicDigestFile(root, 'e1'), 'utf8')).toContain('legacy prose from gen 7')
      expect(readEpicRun(root, 'e1')).toMatchObject({ dryGens: 8, digest: 'legacy prose from gen 7' })
    })

    /**
     * THE CLOBBER WINDOW, closed. The engine patches a run by read-merge-write,
     * so a werk-master that rewrote `digest.md` between the read and the write
     * would have its prose written back stale -- the same collision in the other
     * direction. A patch that does not name `digest` therefore does not touch
     * the digest file at all.
     *
     * THE TRAILING BLANK LINES ARE THE ASSERTION, not sloppy fixture bytes.
     * `writeRun` normalises prose to `${digest.trim()}\n`, so bytes that are NOT
     * in that canonical form are the only evidence available from outside that
     * the writer never opened the file. Round-tripping the same string through
     * a re-write is a no-op on disk, and `patchEpicRun` re-reads internally --
     * so a merged struct carrying the prose back to `writeRun` reproduces
     * canonical bytes byte-for-byte and reads as "untouched". Written this way
     * the test fails the moment `patchEpicRun` stops forwarding `patch.digest`
     * and lets the merged run carry it instead.
     */
    test('a patch that does not name the digest does not WRITE the digest file', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      const current = readEpicRun(root, 'e1')
      const asWritten = 'written by the werk-master mid-beat\n\n\n'

      writeFileSync(epicDigestFile(root, 'e1'), asWritten)
      patchEpicRun(root, 'e1', { dryGens: current!.dryGens + 1 }, T0 + 1)

      expect(readFileSync(epicDigestFile(root, 'e1'), 'utf8')).toBe(asWritten)
      // ...and the prose still reads back, so this is not "untouched because empty".
      expect(readEpicRun(root, 'e1')?.digest).toBe('written by the werk-master mid-beat')
    })

    /** A resume must not reset the prose either -- same argument as the dry
     *  streak's ceiling: the last generation's account of the run outlives it. */
    test('re-arming keeps the digest the last generation wrote', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      patchEpicRun(root, 'e1', { digest: 'three cards left', status: 'paused' }, T0 + 1)

      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0 + 2)

      expect(readEpicRun(root, 'e1')?.digest).toBe('three cards left')
    })

    /** A deleted digest file falls back to `run.md`'s body -- which now says only
     *  "machine-owned". That banner is not a digest and must never read as one. */
    test('the machine-owned banner never reads back as a digest', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      patchEpicRun(root, 'e1', { digest: 'something' }, T0 + 1)
      rmSync(epicDigestFile(root, 'e1'))

      expect(readEpicRun(root, 'e1')?.digest).not.toContain(RUN_FILE_BANNER)
      expect(readEpicRun(root, 'e1')?.digest).toContain('No digest yet')
    })
  })

  /**
   * THE MIRROR, GONE -- and this is the test that says a stale one is INERT.
   *
   * Every `run.md` armed before this card carries a `gen:` key, and so does any
   * file a human or an agent edits by hand. Nothing reads it: the parse drops it
   * and the next write does not put it back. A file claiming generation 99 is
   * therefore indistinguishable, to every reader in the engine, from one that
   * never mentioned a generation at all.
   */
  test('a `gen` hand-edited into run.md is read by nobody and does not survive a write', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    const file = epicRunFile(root, 'e1')
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: armed', 'status: armed\ngen: 99'), 'utf8')

    expect(readEpicRun(root, 'e1')).not.toHaveProperty('gen')

    patchEpicRun(root, 'e1', { dryGens: 1 }, T0 + 1)
    expect(readFileSync(file, 'utf8')).not.toContain('gen: 99')
  })

  /**
   * THE OTHER TWO HANDBRAKES. `maxGens` bounds how often the WERK-MASTER THINKS and
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

  /**
   * AN OLDER BUNDLE MUST NOT BE ABLE TO DELETE A NEWER ONE'S FIELDS.
   *
   * `writeRun` serialised the typed object and nothing else, so any build read a
   * `run.md`, dropped every key it had not heard of, and wrote the remainder
   * back. Harmless while one build exists; lethal the moment two do -- the
   * sentinel ships as a FROZEN BUNDLE and deploys separately from the broker, so
   * a bundle predating the ceilings would open a `run.md` carrying `maxUsd`,
   * `maxWallClockMinutes` and `spentUsd` and rewrite it WITHOUT them. The
   * ceilings did not lapse; a routine patch deleted them, silently.
   *
   * THE OLDER FIELD SET IS SIMULATED BY A NEWER ONE, and it is the same
   * mechanism seen from the other end: a key this build has never heard of is
   * exactly what `maxUsd` was to the bundle that stripped it. Testing it this way
   * is the only honest option -- a test cannot import a parser that no longer
   * exists, and it is the FORWARD direction that is now guaranteed.
   *
   * This cannot retro-fix a bundle already frozen without the passthrough. That
   * is what the arm refusal (`capCapabilityRefusal`) and `capBeat`'s park are
   * for; this is what stops the next field from repeating it.
   */
  describe('a field this build does not know survives the round trip', () => {
    /** Add a key no reader here has ever heard of, exactly where a newer writer
     *  would have put it. */
    function plantForeignKey(epicId: string, line: string): void {
      const file = epicRunFile(root, epicId)
      writeFileSync(file, readFileSync(file, 'utf8').replace(/^---\n/, `---\n${line}\n`), 'utf8')
    }

    test('a patch does not strip it', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p', maxUsd: 25, maxWallClockMinutes: 60 }, T0)
      plantForeignKey('e1', 'maxTokens: 999')

      patchEpicRun(root, 'e1', { spentUsd: 3 }, T0 + 1)

      const meta = parseFrontmatter(readFileSync(epicRunFile(root, 'e1'), 'utf8')).meta
      expect(meta.maxTokens).toBe('999')
      // And the fields this build DOES own are still exactly where they were.
      expect(readEpicRun(root, 'e1')).toMatchObject({ maxUsd: 25, maxWallClockMinutes: 60, spentUsd: 3 })
    })

    test('a re-arm does not strip it either -- start is a merge, not a clobber', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      plantForeignKey('e1', 'maxTokens: 999')

      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0 + 1)

      expect(parseFrontmatter(readFileSync(epicRunFile(root, 'e1'), 'utf8')).meta.maxTokens).toBe('999')
    })

    /**
     * `gen` IS OWNED BY HAVING BEEN RETIRED. Carrying it through as a foreign key
     * would make a stale generation immortal, which is the second copy that
     * deadlocked `epic-the-wall-ii` on 2026-08-20 -- the wake quoted `run.md` and
     * the CAS compared the card, and they could never agree again.
     */
    test('the RETIRED gen key is still dropped, not preserved as somebody else s field', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      plantForeignKey('e1', 'gen: 12')

      patchEpicRun(root, 'e1', { dryGens: 1 }, T0 + 1)

      expect(parseFrontmatter(readFileSync(epicRunFile(root, 'e1'), 'utf8')).meta.gen).toBeUndefined()
    })

    /**
     * THE DRIFT GUARD, and it is the only thing keeping the list honest.
     *
     * `EPIC_RUN_KEYS` is hand-written, so a field added to `EpicRunMeta` and not
     * added here would be written out and then read back as SOMEBODY ELSE'S key
     * -- carried through forever, immune to the very clearing rules the field was
     * given. This asserts every byte this build emits is a byte it claims.
     */
    test('EPIC_RUN_KEYS claims every key this build writes -- add a field, add it here', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      patchEpicRun(
        root,
        'e1',
        {
          startedAt: new Date(T0).toISOString(),
          planBaseline: 'fingerprint',
          abortReason: 'because',
          acknowledgedAt: new Date(T0).toISOString(),
          unlandedWoken: 'c1@3',
        },
        T0 + 1,
      )

      const written = Object.keys(parseFrontmatter(readFileSync(epicRunFile(root, 'e1'), 'utf8')).meta)
      expect(written.filter(k => !EPIC_RUN_KEYS.includes(k))).toEqual([])
    })

    /** A cleared field must stay cleared. `startedAt` is owned, so the carry-over
     *  may not resurrect the value the re-arm just deleted. */
    test('carrying foreign keys does not resurrect an OWNED field a re-arm cleared', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      patchEpicRun(root, 'e1', { startedAt: new Date(T0).toISOString() }, T0 + 1)
      plantForeignKey('e1', 'maxTokens: 999')

      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0 + 2)

      expect(readEpicRun(root, 'e1')?.startedAt).toBeUndefined()
    })
  })

  /**
   * A TORN `run.md` IS NOT A FRESH RUN -- the dangerous half of
   * `epic-artifact-writes-not-atomic`.
   *
   * Every write was a bare `writeFileSync`, which truncates and then writes, so a
   * killed sentinel left a PREFIX on disk. `parseFrontmatter` answers a file with
   * no complete block with `{ meta: {} }`, and every field below it was coerced
   * through a fallback -- so the prefix read back as `status: armed` with every
   * counter at zero. At generation 0 with `plan: true` and no `planBaseline`,
   * `planningBeat` dispatches a PLANNING GENERATION over the board of a live run
   * that has just lost its state. Nothing threw and nothing logged.
   */
  describe('a truncated run artifact', () => {
    /** The bytes a sentinel killed mid-write actually leaves: a prefix, cut
     *  before the closing `---`. */
    function tear(epicId: string, atByte = 60): string {
      startEpicRun(root, { epicId, project: 'p', plan: true }, T0)
      const file = epicRunFile(root, epicId)
      const torn = readFileSync(file, 'utf8').slice(0, atByte)
      writeFileSync(file, torn, 'utf8')
      return torn
    }

    test('refuses to read, rather than reporting an armed run at generation zero', () => {
      tear('e1')
      expect(() => readEpicRun(root, 'e1')).toThrow(EpicRunUnreadableError)
    })

    test('an EMPTY run.md is the same answer -- not "never started"', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
      writeFileSync(epicRunFile(root, 'e1'), '', 'utf8')
      expect(() => readEpicRun(root, 'e1')).toThrow(EpicRunUnreadableError)
    })

    /** An epic with nothing on disk is still `null`. The third outcome must not
     *  swallow the first, or every unstarted epic becomes an error. */
    test('an epic that was never started still reads as null, not as an error', () => {
      expect(readEpicRun(root, 'never-started')).toBeNull()
    })

    /** `startEpicRun` MERGES onto what it reads. On a torn file it would have
     *  written the defaults back out as a real fresh run -- laundering the
     *  corruption into the record and destroying the spend ledger with it. */
    test('start refuses too, rather than laundering the tear into a fresh run', () => {
      const torn = tear('e1')
      expect(() => startEpicRun(root, { epicId: 'e1', project: 'p' }, T0 + 1)).toThrow(EpicRunUnreadableError)
      // The refusal wrote NOTHING: the bytes on disk are still the torn ones, so
      // a human (or a later card) still has the prefix to recover from.
      expect(readFileSync(epicRunFile(root, 'e1'), 'utf8')).toBe(torn)
    })

    test('patch refuses rather than merging onto invented defaults', () => {
      tear('e1')
      expect(() => patchEpicRun(root, 'e1', { dryGens: 1 }, T0 + 1)).toThrow(EpicRunUnreadableError)
    })

    /** The error has to name the epic and say what to do about it: this reaches a
     *  human through a beat note on the wall, and "cannot read run" with no
     *  subject is a line nobody can act on. */
    test('the refusal names the epic and the recovery', () => {
      tear('e1')
      expect(() => readEpicRun(root, 'e1')).toThrow(/`e1`[\s\S]*re-arm/)
    })

    /** No behaviour change on a well-formed artifact -- including one whose BODY
     *  is truncated, which is a torn write that lost nothing the engine reads. */
    test('a run whose body is cut but whose frontmatter closes still reads', () => {
      startEpicRun(root, { epicId: 'e1', project: 'p', concurrency: 5 }, T0)
      const file = epicRunFile(root, 'e1')
      const whole = readFileSync(file, 'utf8')
      writeFileSync(file, whole.slice(0, whole.indexOf('---\n', 4) + 8), 'utf8')
      expect(readEpicRun(root, 'e1')).toMatchObject({ concurrency: 5, status: 'armed' })
    })
  })

  /** The writes are tmp-and-rename now, and the staging siblings do not survive
   *  the call -- an artifact directory a human reads by hand stays readable. */
  test('a start and a patch leave no staging files in the epic directory', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { dryGens: 1, digest: 'prose' }, T0 + 1)
    appendEpicLog(root, 'e1', { kind: 'intent', convId: 'c', body: 'x' }, T0 + 2)
    expect(readdirSync(join(root, '.rclaude', 'project', 'epics', 'e1')).sort()).toEqual([
      'digest.md',
      'log.md',
      'run.md',
    ])
  })

  test('a junk value falls back to the default instead of poisoning the run', () => {
    startEpicRun(root, { epicId: 'e1', project: 'p' }, T0)
    patchEpicRun(root, 'e1', { status: 'exploded' as never, cadence: 'whenever' as never }, T0 + 1)
    const run = readEpicRun(root, 'e1')
    expect(run?.status).toBe('armed')
    expect(run?.cadence).toEqual(['now'])
  })
})
