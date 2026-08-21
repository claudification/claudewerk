import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../shared/frontmatter'
import { cardPath } from '../shared/project-paths'
import type { EpicOp, EpicOpKind } from '../shared/protocol'
import { handleEpicOp } from './epic-handlers'

const T0 = Date.parse('2026-08-17T10:00:00.000Z')
const EPIC = 'e1'
let root = ''

function op(kind: EpicOpKind, extra: Partial<EpicOp> = {}, at = T0) {
  return handleEpicOp(
    root,
    { type: 'epic_op', requestId: 'r1', projectRoot: root, op: kind, epicId: EPIC, ...extra },
    at,
  )
}

function writeEpicCard() {
  const file = cardPath(root, EPIC, false)
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(file, '---\ntitle: The epic\nstatus: open\ntags: [epic]\n---\n\nBody.\n', 'utf8')
}

function cardMeta() {
  return parseFrontmatter(readFileSync(cardPath(root, EPIC, false), 'utf8')).meta
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epic-handlers-'))
  writeEpicCard()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('handleEpicOp', () => {
  test('an unknown op fails loudly rather than silently succeeding', () => {
    const res = op('teleport' as EpicOpKind)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown epic op')
  })

  test('a throwing handler becomes a failed result, not an unhandled rejection', () => {
    const res = handleEpicOp(
      root,
      { type: 'epic_op', requestId: 'r1', projectRoot: root, op: 'start', epicId: '../escape' },
      T0,
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('invalid epic id')
  })

  test('start arms a run and get reads it back with an empty baton', () => {
    expect(op('start', { start: { cadence: 'window', concurrency: 2 } }).ok).toBe(true)
    const got = op('get')
    expect(got.run?.status).toBe('armed')
    expect(got.run?.cadence).toEqual(['window'])
    expect(got.run?.concurrency).toBe(2)
    expect(got.baton).toEqual([])
  })

  /** A start reply is read as the run's STATUS BLOCK, and a status block that
   *  says "no lease" while an overseer holds one is a lie the caller acts on. */
  test('start carries the current lease back, so a resume reports the holder it actually has', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_over', expectGen: 0, holderAlive: false } })
    expect(op('start').currentLease?.convId).toBe('conv_over')
  })

  test('start on an epic nobody holds reports no lease rather than inventing one', () => {
    expect(op('start').currentLease).toBeNull()
  })

  test('patching a run that was never started fails instead of creating one', () => {
    expect(op('patch', { patch: { gen: 4 } }).ok).toBe(false)
  })

  /**
   * The planning flag has to survive broker -> sentinel -> disk -> read-back. A
   * new field that type-checks at both ends but is dropped by a spread in the
   * middle is the classic way one of these silently stops crossing, and it fails
   * as "planning just never happens" rather than as an error.
   */
  test('the plan flag crosses the seam and lands on disk', () => {
    expect(op('start', { start: { plan: true } }).ok).toBe(true)
    const got = op('get')
    expect(got.run?.plan).toBe(true)
    expect(got.run?.planned).toBe(false)
  })

  test('planning defaults ON when the caller says nothing', () => {
    expect(op('start', {}).ok).toBe(true)
    expect(op('get').run?.plan).toBe(true)
  })

  test('opting OUT arms a run that owes no planning generation', () => {
    expect(op('start', { start: { plan: false } }).ok).toBe(true)
    const got = op('get')
    expect(got.run?.plan).toBe(false)
    // `planned` true is what makes the beat skip the gate entirely.
    expect(got.run?.planned).toBe(true)
  })

  /**
   * RESUME NEVER RE-PLANS. Gen 0 already ran; re-planning would burn a generation
   * churning cards that live workers may be holding open.
   */
  test('re-arming a planned run does not owe another planning generation', () => {
    op('start', { start: { plan: true } })
    op('patch', { patch: { planned: true } })
    expect(op('start', { start: { plan: true } }).ok).toBe(true)
    expect(op('get').run?.planned).toBe(true)
  })

  test('log_append persists and get returns the tail', () => {
    op('start')
    op('log_append', { logAppend: { kind: 'dispatch', convId: 'conv_1', cardId: 't1', body: 'sent t1' } })
    const got = op('get')
    expect(got.baton).toHaveLength(1)
    expect(got.baton?.[0].cardId).toBe('t1')
  })
})

/**
 * TWO ANSWERS FROM ONE READ. The baton is sized for an overseer prompt; the
 * acknowledgement set is not a tail question at all. Answering the second with
 * the first froze epic-the-wall for five generations (2026-08-19), and widening
 * the tail to repair it would have put the whole log in every prompt.
 */
describe('get -- the acknowledgement set, folded over the WHOLE log', () => {
  const settle = (cardId: string) =>
    op('log_append', { logAppend: { kind: 'completion', convId: 'broker', cardId, body: `${cardId} settled` } })

  test('cards acknowledged past the prompt tail are still reported as acknowledged', () => {
    op('start')
    const ids = Array.from({ length: 25 }, (_, i) => `t${i + 1}`)
    for (const id of ids) settle(id)

    const got = op('get')
    expect(got.baton).toHaveLength(20) // the prompt tail is untouched
    expect(got.acknowledgedCardIds).toHaveLength(25)
    expect(got.acknowledgedCardIds).toContain('t1') // scrolled out of the tail, still acknowledged
  })

  test('a dispatch acknowledges nothing; a verdict does', () => {
    op('start')
    op('log_append', { logAppend: { kind: 'dispatch', convId: 'c', cardId: 't1', body: '' } })
    op('log_append', { logAppend: { kind: 'verdict', convId: 'c', cardId: 't2', body: '' } })
    expect(op('get').acknowledgedCardIds).toEqual(['t2'])
  })

  test('a run with no log yet acknowledges nothing rather than failing', () => {
    op('start')
    expect(op('get').acknowledgedCardIds).toEqual([])
  })

  /**
   * The belt beside the braces. `log.md` held NINE identical
   * `completion [broker] wall-surface-shell` lines during the live incident --
   * one per sweep. The read bug that produced them is fixed; this makes the
   * write refuse to produce them again, so a human reading the baton never has
   * to work out which of nine is the real one.
   */
  test('re-acknowledging a settled card writes nothing and returns the entry already on disk', () => {
    op('start')
    const first = settle('t1')
    const second = settle('t1')
    expect(second.ok).toBe(true)
    expect(second.logEntry).toEqual(first.logEntry)
    expect(op('get').baton).toHaveLength(1)
  })

  test('but an agent-authored entry about the same card is still appended -- the log stays append-only', () => {
    op('start')
    settle('t1')
    op('log_append', { logAppend: { kind: 'completion', convId: 'conv_overseer', cardId: 't1', body: 'my take' } })
    op('log_append', { logAppend: { kind: 'verdict', convId: 'conv_verifier', cardId: 't1', body: 'approved' } })
    expect(op('get').baton).toHaveLength(3)
  })
})

describe('the lease op -- the singleton, under contention', () => {
  test('the first wake takes generation 1 and flips the run to running', () => {
    op('start')
    const res = op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    expect(res.lease?.granted).toBe(true)
    expect(res.lease?.gen).toBe(1)
    expect(op('get').run?.status).toBe('running')
  })

  test('the lease is written to the EPIC CARD, where a human can see it', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    const meta = cardMeta()
    expect(meta.overseer).toBe('conv_a')
    // frontmatter.ts keeps bare scalars as STRINGS by design; readLease coerces.
    expect(String(meta.overseer_gen)).toBe('1')
    expect(meta.title).toBe('The epic') // the rest of the card is untouched
  })

  test('TWO wakes on the same beat: one grants, one is refused as stale', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    const second = op('lease', { lease: { convId: 'conv_b', expectGen: 1, holderAlive: true } }, T0 + 100)
    expect(second.lease?.granted).toBe(false)
    expect(second.lease?.convId).toBe('conv_a')
    const third = op('lease', { lease: { convId: 'conv_c', expectGen: 0, holderAlive: false } }, T0 + 200)
    expect(third.lease?.granted).toBe(false)
    expect(third.lease?.reason).toContain('stale wake')
  })

  test('release drops the grip but keeps the generation counter', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    expect(op('release').ok).toBe(true)
    expect(cardMeta().overseer).toBe('')
    expect(String(cardMeta().overseer_gen)).toBe('1')

    const next = op('lease', { lease: { convId: 'conv_b', expectGen: 1, holderAlive: false } }, T0 + 500)
    expect(next.lease?.granted).toBe(true)
    expect(next.lease?.gen).toBe(2)
  })

  test('force breaks a live lease -- the human override', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    const forced = op('lease', { lease: { convId: 'conv_x', expectGen: 999, holderAlive: true, force: true } })
    expect(forced.lease?.granted).toBe(true)
    expect(forced.lease?.convId).toBe('conv_x')
  })

  test('leasing an epic with no card fails rather than inventing one', () => {
    rmSync(cardPath(root, EPIC, false))
    op('start')
    expect(op('lease', { lease: { convId: 'c', expectGen: 0, holderAlive: false } }).ok).toBe(false)
  })
})

describe('pause and abort', () => {
  test('pause stops the run and releases the lease', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    expect(op('pause').run?.status).toBe('paused')
    expect(cardMeta().overseer).toBe('')
  })

  test('abort records the reason in the append-only baton', () => {
    op('start')
    const res = op('abort', { reason: 'scope changed' })
    expect(res.run?.status).toBe('aborted')
    const baton = op('get').baton ?? []
    expect(baton.at(-1)?.body).toContain('scope changed')
  })

  test('re-arming after a pause resumes rather than resetting the counter', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })
    op('pause')
    expect(op('start').run?.status).toBe('armed')
    expect(op('get').run?.gen).toBe(1)
  })
})

/**
 * CLEAR -- the burial O2 never gave a dead run.
 *
 * Two properties carry the whole design: it must never be usable as a quieter
 * ABORT (or the wall's tidy-up button becomes its most destructive control), and
 * it must never DESTROY anything (or tidying a pane costs the record the engine
 * exists to keep).
 */
describe('clear -- acknowledging a run that has ended', () => {
  test('an ENDED run takes the acknowledgement and keeps its status', () => {
    op('start')
    op('abort', { reason: 'scope changed' })

    const res = op('clear', {}, T0 + 5_000)

    expect(res.ok).toBe(true)
    expect(res.run?.acknowledgedAt).toBe(new Date(T0 + 5_000).toISOString())
    // The status is untouched -- `clear` records that a human SAW the ending,
    // it does not invent a new one.
    expect(op('get').run?.status).toBe('aborted')
  })

  test('a paused run can be cleared too -- aborted is not the only way to end', () => {
    op('start')
    op('pause')
    expect(op('clear').ok).toBe(true)
    expect(op('get').run?.acknowledgedAt).toBeTruthy()
  })

  test('IT REFUSES AN ARMED RUN, so it can never be a quieter abort', () => {
    op('start')

    const res = op('clear')

    expect(res.ok).toBe(false)
    expect(res.error).toContain('armed')
    expect(op('get').run?.status).toBe('armed')
    expect(op('get').run?.acknowledgedAt).toBeUndefined()
  })

  test('it refuses a RUNNING run for the same reason', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })

    expect(op('get').run?.status).toBe('running')
    expect(op('clear').ok).toBe(false)
  })

  test('a run that was never started cannot be cleared', () => {
    const res = op('clear')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
  })

  /** IT ACKNOWLEDGES, IT DOES NOT DELETE. The baton keeps every entry it had and
   *  gains one saying what happened -- that is the whole difference from a
   *  delete, and it is the reason Q1 was answered ACK. */
  test('the baton is kept and gains a line, rather than being destroyed', () => {
    op('start')
    op('abort', { reason: 'scope changed' })
    const before = (op('get').baton ?? []).length

    op('clear')

    const baton = op('get').baton ?? []
    expect(baton.length).toBe(before + 1)
    expect(baton.at(-1)?.body).toContain('CLEARED')
    expect(baton.some(e => e.body.includes('scope changed'))).toBe(true)
  })

  /** A RUN THAT STARTED AGAIN IS NEWS AGAIN -- otherwise a re-armed run would
   *  stay off the wall while it was genuinely running, which is the exact
   *  invisibility O2 exists to prevent. */
  test('re-arming a cleared run drops the acknowledgement', () => {
    op('start')
    op('pause')
    op('clear')
    expect(op('get').run?.acknowledgedAt).toBeTruthy()

    op('start')

    expect(op('get').run?.acknowledgedAt).toBeUndefined()
  })
})

/**
 * DELETE -- removing a run from the record, RECOVERABLY.
 *
 * Three properties, and they are the three the 2026-08-20 refusal demanded:
 * nothing is destroyed (it is a `mv`, and the files must still be there
 * afterwards), a live run cannot be tidied away (the allowlist), and the run's
 * own account of why it went travels INTO the tombstone rather than being lost
 * with it.
 */
describe('delete -- removing a run from the record', () => {
  const deletedYard = () => join(root, '.rclaude', 'project', 'epics', '.deleted')

  /** The one tombstone under `.deleted/`, or null. Named rather than globbed at
   *  the call site: every assertion below is about the SAME directory. */
  function tombstone(): string | null {
    if (!existsSync(deletedYard())) return null
    const [dir] = readdirSync(deletedYard())
    return dir ? join(deletedYard(), dir) : null
  }

  test('an ENDED run is moved out of the live tree, not removed from disk', () => {
    op('start')
    op('abort', { reason: 'armed the wrong card' })

    const res = op('delete', { reason: 'duplicate run' }, T0 + 5_000)

    expect(res.ok).toBe(true)
    // GONE from where every surface looks...
    expect(op('get').run).toBeNull()
    expect(existsSync(join(root, '.rclaude', 'project', 'epics', EPIC))).toBe(false)
    // ...and STILL THERE where a human can put it back. This assertion IS the
    // answer to "deleting the artifact destroys the run's history".
    const grave = tombstone()
    expect(grave).toBeTruthy()
    expect(existsSync(join(grave as string, 'run.md'))).toBe(true)
    expect(existsSync(join(grave as string, 'log.md'))).toBe(true)
  })

  test('the reply names where the tree went, relative to the project', () => {
    op('start')
    op('pause')

    const res = op('delete', {}, T0 + 5_000)

    expect(res.deletedTo).toBe(join('.rclaude', 'project', 'epics', '.deleted', `${EPIC}-2026-08-17T10-00-05-000Z`))
    // Relative, so a wall row can print it without publishing the box's layout.
    expect(res.deletedTo?.startsWith('/')).toBe(false)
  })

  test('the WHOLE tree travels, including whatever a later card puts beside run.md', () => {
    op('start')
    op('pause')
    writeFileSync(join(root, '.rclaude', 'project', 'epics', EPIC, 'notes.md'), 'a later artifact\n', 'utf8')

    op('delete')

    expect(existsSync(join(tombstone() as string, 'notes.md'))).toBe(true)
  })

  test('the delete is recorded in the baton BEFORE the move, so the tombstone explains itself', () => {
    op('start')
    op('abort', { reason: 'scope changed' })

    op('delete', { reason: 'armed by mistake' })

    const log = readFileSync(join(tombstone() as string, 'log.md'), 'utf8')
    expect(log).toContain('DELETED')
    expect(log).toContain('armed by mistake')
    // Everything the run ever said is still in there beside it.
    expect(log).toContain('scope changed')
  })

  /**
   * THE ALLOWLIST, and it is stricter than `clear`'s denylist on purpose: an
   * acknowledgement written to the wrong run is one click from being undone, a
   * delete moves the artifact.
   */
  test('IT REFUSES AN ARMED RUN -- a tidy-up control can never stop live work', () => {
    op('start')

    const res = op('delete')

    expect(res.ok).toBe(false)
    expect(res.error).toContain('armed')
    expect(op('get').run?.status).toBe('armed')
    expect(existsSync(deletedYard())).toBe(false)
  })

  test('it refuses a RUNNING run for the same reason', () => {
    op('start')
    op('lease', { lease: { convId: 'conv_a', expectGen: 0, holderAlive: false } })

    expect(op('get').run?.status).toBe('running')
    expect(op('delete').ok).toBe(false)
    expect(op('get').run?.status).toBe('running')
  })

  test.each(['paused', 'aborted', 'complete'])('a %s run is deletable', status => {
    op('start')
    op('patch', { patch: { status } as never })

    expect(op('delete').ok).toBe(true)
  })

  test('a run that was never started cannot be deleted', () => {
    const res = op('delete')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not found')
    expect(existsSync(deletedYard())).toBe(false)
  })

  /** Deleting the same epic twice must never clobber the first tombstone -- that
   *  would be an `rm` wearing a `mv`'s clothes. */
  test('deleting the same epic twice keeps BOTH tombstones', () => {
    op('start')
    op('pause')
    op('delete', {}, T0 + 1_000)
    op('start', {}, T0 + 2_000)
    op('pause', {}, T0 + 3_000)
    op('delete', {}, T0 + 4_000)

    expect(readdirSync(deletedYard()).length).toBe(2)
  })

  /** The epic CARD is not the run. Cards outlive runs by design -- it is what
   *  lets an epic adopt work that already exists -- and a delete that quietly
   *  took the card with it would destroy the actual work. */
  test('the epic CARD is untouched', () => {
    op('start')
    op('pause')

    op('delete')

    expect(existsSync(cardPath(root, EPIC, false))).toBe(true)
    expect(cardMeta().title).toBe('The epic')
  })
})
