import { describe, expect, test } from 'bun:test'
import { completionBody, deathBody, dirtSentence } from './epic-dead-seat-report'
import type { AbandonedSeat } from './epic-sweep'
import type { GitDirt } from './epic-types'

const BRANCH = 'worktree-epic/e1/runner-run-delete-verb'

const seat = (over: Partial<AbandonedSeat> = {}): AbandonedSeat => ({
  cardId: 'runner-run-delete-verb',
  convId: 'b00b2d28-2c07-4a53-a1a5-51e6af406134',
  role: 'werk-worker',
  gen: 6,
  lastActivity: Date.parse('2026-08-21T16:38:35.127Z'),
  silentForMs: 12 * 60_000,
  status: 'idle',
  ...over,
})

const dirty: GitDirt = { ok: true, dirty: new Set([BRANCH]), known: new Set([BRANCH]), merged: new Set() }
const clean: GitDirt = { ok: true, dirty: new Set(), known: new Set([BRANCH]), merged: new Set() }

describe('a settle caused by a DEATH reads differently from a settle caused by a finish', () => {
  /**
   * THE DONE-LIST ITEM THIS FILE EXISTS FOR. A werk-master reading `log.md` alone
   * has to be able to tell "the work finished" (send a werk-verifier) from "the worker
   * died" (go and look at the worktree). They share the `completion` KIND by
   * necessity -- see the module docstring -- so the body has to carry it.
   */
  test('the two bodies are not the same sentence', () => {
    expect(deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: clean })).not.toBe(
      completionBody('runner-run-delete-verb'),
    )
  })

  test('the death body says the seat died, in the first clause', () => {
    const body = deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: clean })
    expect(body.slice(0, 120)).toContain('SEAT DIED')
  })

  test('the ordinary completion never claims a death', () => {
    expect(completionBody('t1')).not.toContain('DIED')
  })

  test('it names the conversation, the role and the generation -- checkable by hand', () => {
    const body = deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: clean })
    expect(body).toContain('b00b2d28-2c07-4a53-a1a5-51e6af406134')
    expect(body).toContain('werk-worker')
    expect(body).toContain('generation 6')
  })

  /** The status field is the thing that lied; a report that hid it would leave
   *  the reader unable to see why the engine believed the seat was alive. */
  test('it names the status the registry was still reporting', () => {
    expect(deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: clean })).toContain('`idle`')
  })

  test('it says the slot has been released', () => {
    expect(deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: clean })).toContain('SLOT IS NOW RELEASED')
  })

  test('it refuses to be read as a verdict', () => {
    expect(deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: clean })).toContain('NOBODY WROTE A VERDICT')
  })

  test('minutes are floored, so the figure understates rather than overstates', () => {
    const body = deathBody({
      seat: seat({ silentForMs: 11 * 60_000 + 59_000 }),
      lane: 'open',
      branch: BRANCH,
      dirt: clean,
    })
    expect(body).toContain('11 minute(s)')
  })
})

describe('the card lane is reported, because the lane is what made this invisible', () => {
  test('a card still at `open` is called out -- the board claims nobody worked it', () => {
    const body = deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: clean })
    expect(body).toContain('still at `open`')
    expect(body).toContain('nobody has ever worked it')
  })

  test('a card at `in-progress` is reported plainly, not as never-started', () => {
    const body = deathBody({ seat: seat(), lane: 'in-progress', branch: BRANCH, dirt: clean })
    expect(body).toContain('at `in-progress`')
    expect(body).not.toContain('nobody has ever worked it')
  })

  test('a card the board read did not carry says so rather than guessing', () => {
    expect(deathBody({ seat: seat(), lane: undefined, branch: BRANCH, dirt: clean })).toContain('did not carry')
  })
})

describe('the dirty worktree is named, so the next generation need not go looking', () => {
  /**
   * 2026-08-21: the seat had committed `adb50250` and then written 392 lines of
   * finished tests WITHOUT STAGING THEM. The board said `open`, the baton said
   * nothing, and the work was found only because a human ran `git status` in a
   * worktree for a card the board called unworked.
   */
  test('a dirty branch is named, in capitals, with the branch', () => {
    const body = deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: dirty })
    expect(body).toContain(BRANCH)
    expect(body).toContain('HAS UNCOMMITTED CHANGES')
  })

  /** Explicitly out of scope on the card: deciding whether a corpse's work is
   *  finished is a judgement, and a judgement belongs to the werk-master. */
  test('and the engine says plainly that it committed nothing on the seat behalf', () => {
    const body = deathBody({ seat: seat(), lane: 'open', branch: BRANCH, dirt: dirty })
    expect(body).toContain('nothing has been committed on its behalf')
  })

  test('a clean branch is reported as clean', () => {
    expect(dirtSentence(BRANCH, clean)).toContain('no uncommitted changes')
  })

  test('NO SCAN is UNKNOWN, never clean', () => {
    expect(dirtSentence(BRANCH, null)).toContain('UNKNOWN')
    expect(dirtSentence(BRANCH, null)).not.toContain('no uncommitted changes')
  })

  test('a FAILED scan is UNKNOWN and carries the reason', () => {
    const said = dirtSentence(BRANCH, { ok: false, error: 'sentinel offline' })
    expect(said).toContain('UNKNOWN')
    expect(said).toContain('sentinel offline')
  })

  /** A branch the scan never saw is not a branch the scan cleared. Reporting it
   *  as clean would be the engine certifying a directory nothing opened. */
  test('a branch the scan never saw is neither dirty nor clean', () => {
    const said = dirtSentence(BRANCH, { ok: true, dirty: new Set(), known: new Set(['main']), merged: new Set() })
    expect(said).toContain('saw no branch')
    expect(said).toContain('not the same as clean')
  })
})
