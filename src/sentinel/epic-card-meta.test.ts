/**
 * KILLING THE WRITER MID-WRITE -- the card half of `epic-artifact-writes-not-atomic`.
 *
 * `run.md` got both halves of that fix in August: `writeFileAtomic` so a killed
 * sentinel cannot leave a prefix, and `EpicRunUnreadableError` so a prefix that
 * exists anyway is never believed. The CARD -- which carries the werk-master lease
 * and every seat lease, i.e. the mutual exclusion the whole engine's
 * one-writer-per-card guarantee rests on -- got neither, and it is the more
 * expensive of the two files to lose:
 *
 *   - a torn `run.md` read back as a fresh armed run at generation zero;
 *   - a torn CARD reads back as `{}`, which `readLease` reports as `null`, which
 *     `evaluateLease` defines (correctly) as "never woken" and grants at
 *     generation 1 -- RESETTING the counter the CAS exists to compare, while the
 *     baton already holds gens 1..N;
 *   - and because `patchCardMeta` is read-modify-write over the WHOLE card, the
 *     very next lease write emits a card whose entire frontmatter is three lease
 *     keys. No title, no status, no `epic:`, no `depends_on:`, no promise ledger.
 *
 * These tests do the killing rather than describing it: they leave the exact
 * bytes a SIGKILL mid-write leaves, and assert the engine refuses them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLease } from '../shared/epic-lease'
import { cardPath } from '../shared/project-paths'
import type { EpicOp, EpicOpKind } from '../shared/protocol'
import { EpicCardUnreadableError, patchCardMeta, readCardMeta } from './epic-card-meta'
import { handleEpicOp } from './epic-handlers'

const T0 = Date.parse('2026-08-22T10:00:00.000Z')
const EPIC = 'e1'
let root = ''

const file = () => cardPath(root, EPIC, false)

/** A real epic card, mid-run: it has been woken seven times and a werk-master holds
 *  it right now. Everything below is about not losing this. */
function writeCard(): void {
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(
    file(),
    [
      '---',
      'title: The epic',
      'status: in-progress',
      'epic: parent-epic',
      'depends_on: [t1, t2]',
      'overseer: conv_live',
      'overseer_gen: 7',
      `overseer_at: ${new Date(T0 - 60_000).toISOString()}`,
      '---',
      '',
      'The body nobody wants to lose.',
      '',
    ].join('\n'),
    'utf8',
  )
}

/** THE BYTES A SIGKILL MID-WRITE ACTUALLY LEAVES: a prefix, cut before the
 *  closing `---`. `writeFileSync` opens with O_TRUNC, so every byte after the cut
 *  is simply gone. */
function tear(atByte = 40): void {
  writeFileSync(file(), readFileSync(file(), 'utf8').slice(0, atByte), 'utf8')
}

/** One op against the torn card, through the REAL handler map -- `runGuarded`
 *  included, since that is the seam that turns the throw into a refusal. */
function op(kind: EpicOpKind, extra: Partial<EpicOp> = {}) {
  return handleEpicOp(
    root,
    { type: 'epic_op', requestId: 'r1', projectRoot: root, op: kind, epicId: EPIC, ...extra },
    T0,
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epic-card-meta-'))
  writeCard()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the lease write is atomic', () => {
  /**
   * THE PROPERTY, ASSERTED RATHER THAN TRUSTED. A rename replaces a directory
   * entry, so the path points at a NEW inode; `writeFileSync` truncates the
   * existing one in place and keeps it. That inode is the whole difference between
   * "a killed process cannot tear this file" and "a killed process leaves a
   * prefix", and it is the only observable difference from outside the write.
   */
  test('the card is REPLACED by rename, never truncated in place', () => {
    const before = statSync(file()).ino
    expect(patchCardMeta(root, EPIC, { overseer_gen: 8 })).toBe(true)
    expect(statSync(file()).ino).not.toBe(before)
  })

  test('and the card keeps everything the patch did not name', () => {
    patchCardMeta(root, EPIC, { overseer: 'conv_next', overseer_gen: 8 })
    const meta = readCardMeta(root, EPIC)
    expect(meta?.title).toBe('The epic')
    expect(meta?.status).toBe('in-progress')
    expect(meta?.epic).toBe('parent-epic')
    expect(meta?.depends_on).toEqual(['t1', 't2'])
    expect(readFileSync(file(), 'utf8')).toContain('The body nobody wants to lose.')
  })

  test('a card that is genuinely absent is `false`, not a throw', () => {
    expect(patchCardMeta(root, 'no-such-card', { overseer_gen: 1 })).toBe(false)
    expect(readCardMeta(root, 'no-such-card')).toBeNull()
  })
})

describe('a torn card is never believed', () => {
  test('reading one throws rather than answering with an empty bag', () => {
    tear()
    expect(() => readCardMeta(root, EPIC)).toThrow(EpicCardUnreadableError)
  })

  test('an EMPTY card is the same answer -- not "this card has no lease"', () => {
    writeFileSync(file(), '', 'utf8')
    expect(() => readCardMeta(root, EPIC)).toThrow(EpicCardUnreadableError)
  })

  /** The half that matters most. Believing the tear turns a recoverable prefix
   *  into a card with no title, no status and no dependencies -- destroyed by the
   *  repair, not by the crash. */
  test('patching one REFUSES rather than rewriting the card as three lease keys', () => {
    tear()
    const torn = readFileSync(file(), 'utf8')
    expect(() => patchCardMeta(root, EPIC, { overseer: 'conv_next', overseer_gen: 8 })).toThrow(EpicCardUnreadableError)
    expect(readFileSync(file(), 'utf8')).toBe(torn)
  })

  test('the message names the card and the recovery, so a human is not left guessing', () => {
    tear()
    expect(() => readCardMeta(root, EPIC)).toThrow(/e1.*UNREADABLE.*git checkout/s)
  })
})

/**
 * THROUGH THE REAL HANDLERS. `runGuarded` is what turns the throw into a refusal,
 * and that seam is the reason this is a throw rather than a third return value:
 * one throw makes EVERY op refuse instead of eight call sites each remembering to
 * check a flag.
 */
describe('every op refuses on a torn card, rather than acting on a reset generation', () => {
  test('a wake does NOT get granted generation 1 over a run already at 7', () => {
    tear()
    const res = op('lease', { lease: { convId: 'conv_waker', expectGen: 0, holderAlive: false } })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('UNREADABLE')
    expect(res.lease).toBeUndefined()
  })

  test('a seat claim refuses too -- the same card, the same tear, a different lane', () => {
    tear()
    const res = op('seat_claim', { seat: { cardId: EPIC, role: 'werk-worker', convId: 'conv_seat' } })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('UNREADABLE')
  })

  /** And the run reads as UNREADABLE rather than as an epic that has never been
   *  woken -- which is what `runEpicBeat` refuses to act on, so the beat skips
   *  instead of replanning a live board. */
  test('a get reports the failure instead of a lease of null at generation 0', () => {
    tear()
    const res = op('get')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('UNREADABLE')
  })

  /** The intact card, for contrast: the generation the baton already holds is the
   *  generation the CAS compares, and it survives every one of the writes above. */
  test('an INTACT card still reports the generation it is actually at', () => {
    expect(readLease(readCardMeta(root, EPIC) ?? {})).toMatchObject({ convId: 'conv_live', gen: 7 })
  })
})
