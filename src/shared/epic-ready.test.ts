import { describe, expect, test } from 'bun:test'
import { MAX_CARD_SEATS, NEEDS_REFINE_TAG, planEpic, planTagged } from './epic-ready'
import { NEEDS_OVERSEER_TAG } from './epic-run-types'
import type { ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'

let seq = 0
function card(slug: string, status: TaskStatus, extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  seq += 1
  return {
    slug,
    status,
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-17T10:00:00Z',
    mtime: seq,
    bodyPreview: '',
    ...extra,
  }
}

const EPIC = card('e1', 'open', { tags: ['epic'] })
const plan = (cards: ProjectTaskMeta[], concurrency = 3, inFlight: string[] = [], inVerify: string[] = []) =>
  planEpic({ cards, epicId: 'e1', concurrency, inFlight, inVerify })

/** Cards whose seats keep failing to launch (`EpicGroup.unspawnable`). */
const planDead = (cards: ProjectTaskMeta[], unspawnable: string[]) =>
  planEpic({ cards, epicId: 'e1', concurrency: 3, inFlight: [], inVerify: [], unspawnable })

describe('planEpic', () => {
  test('an epic nobody declared is reported, not crashed on', () => {
    const p = planEpic({ cards: [], epicId: 'ghost', concurrency: 3, inFlight: [], inVerify: [] })
    expect(p.rollup).toBeNull()
    expect(p.idleReason).toContain('no epic')
  })

  test('dispatches only cards whose dependencies are done', () => {
    const p = plan([
      EPIC,
      card('t1', 'done', { epic: 'e1' }),
      card('t2', 'open', { epic: 'e1', dependsOn: ['t1'] }),
      card('t3', 'open', { epic: 'e1', dependsOn: ['t2'] }),
    ])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t2'])
    expect(p.waitingOnDeps.map(w => w.card.slug)).toEqual(['t3'])
  })

  test('the concurrency ceiling holds cards back VISIBLY rather than dropping them', () => {
    const cards = [EPIC, ...['t1', 't2', 't3', 't4', 't5'].map(s => card(s, 'open', { epic: 'e1' }))]
    const p = plan(cards, 3)
    expect(p.dispatch).toHaveLength(3)
    expect(p.heldBack).toHaveLength(2)
    expect(p.dispatch.length + p.heldBack.length).toBe(5)
  })

  test('in-flight cards consume slots and are never re-dispatched', () => {
    const cards = [EPIC, ...['t1', 't2', 't3'].map(s => card(s, 'open', { epic: 'e1' }))]
    const p = plan(cards, 3, ['t1'])
    expect(p.dispatch.map(c => c.slug)).not.toContain('t1')
    expect(p.dispatch).toHaveLength(2)
  })

  test('an in-review card asks for a verdict, not another implementer', () => {
    const p = plan([EPIC, card('t1', 'in-review', { epic: 'e1' })])
    expect(p.verify.map(c => c.slug)).toEqual(['t1'])
    expect(p.dispatch).toHaveLength(0)
    expect(p.idleReason).toContain('verdict')
  })

  /**
   * THE VERIFIER FLOOD, 2026-08-19. `verify` was built with no liveness filter at
   * all, so a card parked in `in-review` asked for a fresh verifier on EVERY beat.
   * The sweep runs ~45s, so `node-stats-http-ingest` collected EIGHT concurrent
   * Opus verifiers on one card -- each with its own scratch worktree, each about
   * to write a verdict onto the same card body.
   *
   * It was invisible for as long as it was because the worktree-create SIGPIPE bug
   * killed every duplicate in under two seconds. Fixing the spawn path is what let
   * the flood actually run.
   */
  test('a card already being verified does NOT ask for a second verifier', () => {
    const p = plan([EPIC, card('t1', 'in-review', { epic: 'e1' })], 3, [], ['t1'])
    expect(p.verify).toHaveLength(0)
  })

  test('verifier liveness is per-card, so a sibling still gets its first verdict', () => {
    const p = plan(
      [EPIC, card('t1', 'in-review', { epic: 'e1' }), card('t2', 'in-review', { epic: 'e1' })],
      3,
      [],
      ['t1'],
    )
    expect(p.verify.map(c => c.slug)).toEqual(['t2'])
  })

  /**
   * The lanes are separate seats: a live IMPLEMENTER must not suppress the verdict
   * its own card is owed. Collapsing both roles into one liveness bit is what
   * `epic-sweep.ts` used to do, and it is why `verify` could not tell the
   * difference in the first place.
   */
  test('a live implementer does not suppress the verdict on an in-review card', () => {
    const p = plan([EPIC, card('t1', 'in-review', { epic: 'e1' })], 3, ['t1'], [])
    expect(p.verify.map(c => c.slug)).toEqual(['t1'])
  })

  test('a needs-overseer question is surfaced, never dispatched', () => {
    const p = plan([
      EPIC,
      card('q1', 'open', { epic: 'e1', tags: [NEEDS_OVERSEER_TAG] }),
      card('t1', 'open', { epic: 'e1', dependsOn: ['q1'] }),
    ])
    expect(p.questions.map(c => c.slug)).toEqual(['q1'])
    expect(p.dispatch).toHaveLength(0)
    expect(p.idleReason).toContain('open question')
  })

  test('answering the question card unblocks the card that asked it', () => {
    const p = plan([
      EPIC,
      card('q1', 'done', { epic: 'e1', tags: [NEEDS_OVERSEER_TAG] }),
      card('t1', 'open', { epic: 'e1', dependsOn: ['q1'] }),
    ])
    expect(p.questions).toHaveLength(0)
    expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
  })

  test('high priority sorts ahead of the rest within the ready set', () => {
    const p = plan(
      [
        EPIC,
        card('low', 'open', { epic: 'e1', priority: 'low' }),
        card('high', 'open', { epic: 'e1', priority: 'high' }),
      ],
      1,
    )
    expect(p.dispatch.map(c => c.slug)).toEqual(['high'])
  })

  test('all children terminal reports complete', () => {
    const p = plan([EPIC, card('t1', 'done', { epic: 'e1' }), card('t2', 'archived', { epic: 'e1' })])
    expect(p.complete).toBe(true)
    expect(p.idleReason).toContain('terminal')
  })
})

/**
 * A card whose SEAT cannot launch is not a card that is not ready -- it is a
 * card the engine must stop sending work at. Gen 2 of `epic-the-wall-ii` spent
 * thirteen seats discovering that one card id was too long to be a worktree
 * name; excluding it here is what makes the thirteenth attempt impossible.
 */
describe('cards the engine has given up launching', () => {
  test('are withheld from dispatch', () => {
    const p = planDead([EPIC, card('t1', 'open', { epic: 'e1' }), card('t2', 'open', { epic: 'e1' })], ['t1'])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t2'])
  })

  test('are withheld from VERIFY too -- the launch fails whatever the seat is', () => {
    const p = planDead([EPIC, card('t1', 'in-review', { epic: 'e1' })], ['t1'])
    expect(p.verify).toEqual([])
  })

  test('are named rather than silently dropped', () => {
    const p = planDead([EPIC, card('t1', 'open', { epic: 'e1' })], ['t1'])
    expect(p.unspawnable.map(c => c.slug)).toEqual(['t1'])
  })

  test('outrank every other idle reason -- nothing else here stays broken on its own', () => {
    const p = planDead(
      [EPIC, card('t1', 'in-review', { epic: 'e1' }), card('q1', 'open', { epic: 'e1', tags: [NEEDS_OVERSEER_TAG] })],
      ['t1'],
    )
    expect(p.idleReason).toContain('seats keep dying')
    expect(p.idleReason).toContain('t1')
    expect(p.idleReason).toContain('Spawn FAILED stderr:')
  })

  test('an empty list changes nothing -- the field is optional by design', () => {
    const cards = [EPIC, card('t1', 'open', { epic: 'e1' })]
    expect(planDead(cards, []).dispatch.map(c => c.slug)).toEqual(['t1'])
    expect(plan(cards).unspawnable).toEqual([])
  })
})

/**
 * THE BOUNCE LANE, and the generation this project lost to its absence.
 *
 * `dispatch` considered `notStarted` only and `verify` considers `in-review`
 * only, while `epicBucket` folds BOTH `in-progress` and `in-review` into
 * `inProgress`. A card at `in-progress` was therefore in neither lane -- and that
 * is the lane the overseer prompt tells every overseer a BOUNCED card sits in,
 * promising it "redispatches". Generation 3 of `epic-scanner-fabric` followed
 * that instruction on `scanner-work-orders`; generation 4 woke to a free slot, a
 * dead seat, and a card nobody would ever pick up.
 */
describe('a bounced card at `in-progress` is dispatchable again', () => {
  /** The bounce lane's ceiling input: cardId -> seats the baton has recorded. */
  const planSeats = (cards: ProjectTaskMeta[], dispatches: Record<string, number>, inFlight: string[] = []) =>
    planEpic({ cards, epicId: 'e1', concurrency: 3, inFlight, inVerify: [], dispatches })

  test('with NO live implementer it goes back out', () => {
    const p = plan([EPIC, card('t1', 'in-progress', { epic: 'e1' })])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
    expect(p.idleReason).toBeUndefined()
  })

  test('with a live implementer it does NOT -- one seat per card, still', () => {
    const p = plan([EPIC, card('t1', 'in-progress', { epic: 'e1' })], 3, ['t1'])
    expect(p.dispatch).toEqual([])
    expect(p.exhausted).toEqual([])
    expect(p.idleReason).toContain('still in flight')
  })

  /**
   * `in-review` IS NOT SWEPT IN. That lane belongs to the verifier: an in-review
   * card with no live verifier is already handled by `verify`, and dispatching an
   * implementer onto it would put a writer on a branch a Guard is mid-review of.
   */
  test('an in-review card stays verify-only and is never dispatched', () => {
    const p = plan([EPIC, card('t1', 'in-review', { epic: 'e1' })])
    expect(p.dispatch).toEqual([])
    expect(p.verify.map(c => c.slug)).toEqual(['t1'])
  })

  test('an in-review card with no live verifier is still not dispatched', () => {
    const p = planEpic({
      cards: [EPIC, card('t1', 'in-review', { epic: 'e1' })],
      epicId: 'e1',
      concurrency: 3,
      inFlight: [],
      inVerify: [],
    })
    expect(p.dispatch).toEqual([])
  })

  test('it consumes a concurrency slot like any other dispatch', () => {
    const cards = [
      EPIC,
      card('t1', 'in-progress', { epic: 'e1' }),
      card('t2', 'open', { epic: 'e1' }),
      card('t3', 'open', { epic: 'e1' }),
    ]
    const p = plan(cards, 2)
    expect(p.dispatch.length + p.heldBack.length).toBe(3)
    expect(p.dispatch).toHaveLength(2)
  })

  test('a bounced card still waits on an unfinished dependency', () => {
    const p = plan([
      EPIC,
      card('dep', 'open', { epic: 'e1' }),
      card('t1', 'in-progress', { epic: 'e1', dependsOn: ['dep'] }),
    ])
    expect(p.dispatch.map(c => c.slug)).toEqual(['dep'])
    expect(p.waitingOnDeps.map(w => w.card.slug)).toEqual(['t1'])
  })

  test('a bounced card the engine cannot launch is still withheld', () => {
    const p = planDead([EPIC, card('t1', 'in-progress', { epic: 'e1' })], ['t1'])
    expect(p.dispatch).toEqual([])
    expect(p.unspawnable.map(c => c.slug)).toEqual(['t1'])
  })

  test('a bounced card carrying a question is answered, not re-implemented', () => {
    const p = plan([EPIC, card('t1', 'in-progress', { epic: 'e1', tags: [NEEDS_OVERSEER_TAG] })])
    expect(p.dispatch).toEqual([])
    expect(p.questions.map(c => c.slug)).toEqual(['t1'])
  })

  /**
   * THE RETRY CEILING. "An `in-progress` card is dispatchable again" is right
   * once per bounce and ruinous without a bound: an implementer that dies without
   * moving its card leaves it at `in-progress` forever, which is a fresh seat
   * every 45s. Gen 2 of `epic-the-wall-ii` spent thirteen on one card the last
   * time an unbounded retry path shipped.
   */
  describe('the retry ceiling', () => {
    test('one seat short of the ceiling still dispatches', () => {
      const p = planSeats([EPIC, card('t1', 'in-progress', { epic: 'e1' })], { t1: MAX_CARD_SEATS - 1 })
      expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
      expect(p.exhausted).toEqual([])
    })

    test('at the ceiling it is withheld', () => {
      const p = planSeats([EPIC, card('t1', 'in-progress', { epic: 'e1' })], { t1: MAX_CARD_SEATS })
      expect(p.dispatch).toEqual([])
    })

    test('and is NAMED rather than silently dropped -- the whole bug this file just fixed', () => {
      const p = planSeats([EPIC, card('t1', 'in-progress', { epic: 'e1' })], { t1: MAX_CARD_SEATS + 4 })
      expect(p.exhausted.map(c => c.slug)).toEqual(['t1'])
      expect(p.idleReason).toContain('t1')
      expect(p.idleReason).toContain(String(MAX_CARD_SEATS))
      expect(p.idleReason).not.toContain('nothing ready')
    })

    test('the ceiling is per card -- a sibling with seats to spare still goes out', () => {
      const p = planSeats(
        [EPIC, card('t1', 'in-progress', { epic: 'e1' }), card('t2', 'in-progress', { epic: 'e1' })],
        {
          t1: MAX_CARD_SEATS,
        },
      )
      expect(p.dispatch.map(c => c.slug)).toEqual(['t2'])
      expect(p.exhausted.map(c => c.slug)).toEqual(['t1'])
      expect(p.idleReason).toBeUndefined()
    })

    /**
     * BOTH LANES, since `epic-open-lane-redispatches-forever`. This test pinned
     * the opposite when the ceiling landed -- on the reasoning that a not-started
     * card had never been dispatched, which is false of a card an implementer left
     * in `open`. The ceiling is a per-CARD lifetime budget, so it is one number
     * for both lanes and `status:` is not a lever that refills it.
     */
    test('a not-started card IS subject to it -- the ceiling is per card, not per lane', () => {
      const p = planSeats([EPIC, card('t1', 'open', { epic: 'e1' })], { t1: MAX_CARD_SEATS + 10 })
      expect(p.dispatch).toEqual([])
      expect(p.exhausted.map(c => c.slug)).toEqual(['t1'])
    })

    test('a not-started card below the ceiling still dispatches', () => {
      const p = planSeats([EPIC, card('t1', 'open', { epic: 'e1' })], { t1: MAX_CARD_SEATS - 1 })
      expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
      expect(p.exhausted).toEqual([])
    })

    test('an exhausted card is reported ONCE, and as exhausted rather than dependency-blocked', () => {
      const p = planSeats([EPIC, card('t1', 'in-progress', { epic: 'e1', dependsOn: ['ghost'] })], {
        t1: MAX_CARD_SEATS,
      })
      expect(p.exhausted.map(c => c.slug)).toEqual(['t1'])
      expect(p.waitingOnDeps).toEqual([])
    })

    test('a live seat wins over the ceiling -- an exhausted card being worked is not a stall', () => {
      const p = planSeats([EPIC, card('t1', 'in-progress', { epic: 'e1' })], { t1: MAX_CARD_SEATS }, ['t1'])
      expect(p.exhausted).toEqual([])
      expect(p.idleReason).toContain('still in flight')
    })

    test('an unspawnable card outranks an exhausted one -- its seat cannot launch at all', () => {
      const p = planEpic({
        cards: [EPIC, card('t1', 'in-progress', { epic: 'e1' }), card('t2', 'in-progress', { epic: 'e1' })],
        epicId: 'e1',
        concurrency: 3,
        inFlight: [],
        inVerify: [],
        unspawnable: ['t2'],
        dispatches: { t1: MAX_CARD_SEATS },
      })
      expect(p.idleReason).toContain('seats keep dying')
    })

    test('omitting the counts means no ceiling -- the field is optional by design', () => {
      const p = plan([EPIC, card('t1', 'in-progress', { epic: 'e1' })])
      expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
      expect(p.exhausted).toEqual([])
    })
  })

  /**
   * THE LANE IS THE EPIC SELECTOR'S, AND ONLY ITS. A bounce is something a
   * VERIFIER does, and the tag cohort has no verify lane: the work-order scanner
   * dispatches implementers and nothing else, and deliberately names a `ready`
   * card sitting in `in-progress` `not-actionable`. It also has no baton, so it
   * could not supply the ceiling this lane requires -- and an unbounded bounce
   * lane is the exact failure that ceiling exists to prevent.
   */
  test('the TAG selector does not get it -- an in-progress `ready` card stays untouched', () => {
    const p = planTagged({
      cards: [card('a', 'in-progress', { tags: ['ready'] }), card('b', 'open', { tags: ['ready'] })],
      tag: 'ready',
      concurrency: 3,
      inFlight: [],
      inVerify: [],
    })
    expect(p.dispatch.map(c => c.slug)).toEqual(['b'])
    expect(p.exhausted).toEqual([])
  })
})

/**
 * AN `open` CARD A SEAT ALREADY RAN FOR IS NOT DISPATCHED AGAIN.
 *
 * Dispatching a card does not move it out of `open` -- `spawnForCard` only
 * appends a baton entry -- so an implementer that ran, produced output and died
 * without moving its own card left that card `open`, therefore `notStarted`,
 * therefore dispatchable again on the very next beat. Every 45 seconds, forever:
 * `MAX_LAUNCH_ATTEMPTS` explicitly does not apply, because a card that produced
 * output is `settled` rather than `unspawnable`.
 *
 * The work-order scanner solved exactly this for the tag cohort with its
 * `already-run` refusal, spelled out in its own comment. This is the epic
 * cohort's copy.
 */
describe('an `open` card whose seat already settled -- the `alreadyRun` guard', () => {
  const planSettled = (cards: ProjectTaskMeta[], settled: string[], inFlight: string[] = []) =>
    planEpic({ cards, epicId: 'e1', concurrency: 3, inFlight, inVerify: [], settled })

  test('a card with NO prior seat is dispatched normally', () => {
    const p = planSettled([EPIC, card('t1', 'open', { epic: 'e1' })], [])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
    expect(p.alreadyRun).toEqual([])
  })

  test('a card whose only seat settled without moving it is NOT dispatched a second time', () => {
    const p = planSettled([EPIC, card('t1', 'open', { epic: 'e1' })], ['t1'])
    expect(p.dispatch).toEqual([])
    expect(p.alreadyRun.map(c => c.slug)).toEqual(['t1'])
  })

  test('the bound is ONE seat -- stricter than the ceiling, and it does not wait for it', () => {
    const p = planEpic({
      cards: [EPIC, card('t1', 'open', { epic: 'e1' })],
      epicId: 'e1',
      concurrency: 3,
      inFlight: [],
      inVerify: [],
      settled: ['t1'],
      dispatches: { t1: 1 },
    })
    expect(p.dispatch).toEqual([])
    expect(p.alreadyRun.map(c => c.slug)).toEqual(['t1'])
    expect(p.exhausted).toEqual([])
  })

  test('`inbox` is not-started too, and gets the same guard', () => {
    const p = planSettled([EPIC, card('t1', 'inbox', { epic: 'e1' })], ['t1'])
    expect(p.alreadyRun.map(c => c.slug)).toEqual(['t1'])
  })

  test('the withheld card is NAMED, with both moves that re-authorise it', () => {
    const p = planSettled([EPIC, card('t1', 'open', { epic: 'e1' })], ['t1'])
    expect(p.idleReason).toContain('t1')
    expect(p.idleReason).toContain('in-review')
    expect(p.idleReason).toContain('in-progress')
    expect(p.idleReason).not.toContain('nothing ready')
  })

  test('it is per card -- a settled sibling does not stall a fresh one', () => {
    const p = planSettled([EPIC, card('t1', 'open', { epic: 'e1' }), card('t2', 'open', { epic: 'e1' })], ['t1'])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t2'])
    expect(p.alreadyRun.map(c => c.slug)).toEqual(['t1'])
    expect(p.idleReason).toBeUndefined()
  })

  test('a live seat wins -- a card being worked right now is not a stall', () => {
    const p = planSettled([EPIC, card('t1', 'open', { epic: 'e1' })], ['t1'], ['t1'])
    expect(p.alreadyRun).toEqual([])
    expect(p.idleReason).toContain('still in flight')
  })

  test('it is reported as already-run rather than dependency-blocked', () => {
    const p = planSettled([EPIC, card('t1', 'open', { epic: 'e1', dependsOn: ['ghost'] })], ['t1'])
    expect(p.alreadyRun.map(c => c.slug)).toEqual(['t1'])
    expect(p.waitingOnDeps).toEqual([])
  })

  /**
   * THE BOUNCE LANE SURVIVES IT. A card at `in-progress` is settled by
   * construction -- its implementer and its verifier both ran and both died --
   * so applying this guard there would delete the lane the bounce card just
   * built. `MAX_CARD_SEATS` bounds that one instead.
   */
  test('a bounced card at `in-progress` is settled and STILL dispatched', () => {
    const p = planSettled([EPIC, card('t1', 'in-progress', { epic: 'e1' })], ['t1'])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
    expect(p.alreadyRun).toEqual([])
  })

  /**
   * WHY BOTH GUARDS EXIST. `settled` is folded from the conversation registry, so
   * it can only see a seat whose agent host connected and stamped an epic tag. A
   * spawn the sentinel accepted whose host never connects is in NO lane -- not
   * `inFlight`, not `settled`, not `failedLegs` -- and the baton count is the only
   * thing that can stop it.
   */
  test('a seat that never connected is invisible to `settled` and caught by the ceiling', () => {
    const p = planEpic({
      cards: [EPIC, card('t1', 'open', { epic: 'e1' })],
      epicId: 'e1',
      concurrency: 3,
      inFlight: [],
      inVerify: [],
      settled: [],
      dispatches: { t1: MAX_CARD_SEATS },
    })
    expect(p.dispatch).toEqual([])
    expect(p.exhausted.map(c => c.slug)).toEqual(['t1'])
    expect(p.alreadyRun).toEqual([])
  })

  test('an unspawnable card outranks an already-run one -- its seat cannot launch at all', () => {
    const p = planEpic({
      cards: [EPIC, card('t1', 'open', { epic: 'e1' }), card('t2', 'open', { epic: 'e1' })],
      epicId: 'e1',
      concurrency: 3,
      inFlight: [],
      inVerify: [],
      settled: ['t1'],
      unspawnable: ['t2'],
    })
    expect(p.alreadyRun.map(c => c.slug)).toEqual(['t1'])
    expect(p.idleReason).toContain('seats keep dying')
  })

  test('omitting `settled` means no guard -- the field is optional by design', () => {
    const p = plan([EPIC, card('t1', 'open', { epic: 'e1' })])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t1'])
    expect(p.alreadyRun).toEqual([])
  })

  /**
   * THE TAG COHORT IS IMMUNE BY OMISSION, exactly as it is for the seat ceiling
   * -- `settled` is optional and the work-order scanner does not pass it, because
   * it runs its own `already-run` refusal BEFORE the fold and feeds the result in
   * through `exclude`. Folding it again here would count one card into two
   * refusal buckets.
   *
   * The arithmetic itself is NOT cohort-specific, and this pins that: a tag
   * cohort that did supply `settled` would get the identical answer. That is the
   * shared-fold contract (`epic-ready.ts` header) -- only the SELECTION differs.
   */
  test('planTagged is immune by omission, and identical when it does supply the set', () => {
    const cards = [card('a', 'open', { tags: ['ready'] })]
    const base = { cards, tag: 'ready', concurrency: 3, inFlight: [], inVerify: [] }
    expect(planTagged(base).dispatch.map(c => c.slug)).toEqual(['a'])
    expect(planTagged(base).alreadyRun).toEqual([])
    expect(planTagged({ ...base, settled: ['a'] }).alreadyRun.map(c => c.slug)).toEqual(['a'])
  })
})

describe('planTagged -- `exclude` narrows the COHORT, never the board', () => {
  const tagged = (cards: ProjectTaskMeta[], exclude?: ReadonlySet<string>) =>
    planTagged({ cards, tag: 'ready', concurrency: 3, inFlight: [], inVerify: [], exclude })

  test('the cohort is the tag, and a dependency outside it still has to be done', () => {
    const p = tagged([
      card('dep', 'open', { tags: [] }),
      card('a', 'open', { tags: ['ready'], dependsOn: ['dep'] }),
      card('b', 'open', { tags: ['ready'] }),
    ])
    expect(p.dispatch.map(c => c.slug)).toEqual(['b'])
    expect(p.waitingOnDeps.map(w => w.card.slug)).toEqual(['a'])
    expect(p.rollup).toBeNull()
  })

  test('an excluded card leaves the cohort', () => {
    const p = tagged([card('a', 'open', { tags: ['ready'] }), card('b', 'open', { tags: ['ready'] })], new Set(['a']))
    expect(p.dispatch.map(c => c.slug)).toEqual(['b'])
    expect(p.waitingOnDeps).toEqual([])
    expect(p.heldBack).toEqual([])
  })

  test('an excluded card is STILL `done` for everybody else -- the deadlock this exists to stop', () => {
    const cards = [card('dep', 'done', { tags: ['ready'] }), card('a', 'open', { tags: ['ready'], dependsOn: ['dep'] })]
    // The caller refusing `dep` must not make it stop counting as a finished
    // dependency: filtering it out of `cards` would take it out of `doneCardIds`
    // and strand `a` in `waitingOnDeps` against a card that is `done`.
    const p = tagged(cards, new Set(['dep']))
    expect(p.dispatch.map(c => c.slug)).toEqual(['a'])
    expect(p.waitingOnDeps).toEqual([])
  })

  test('excluding every tagged card says so, rather than claiming nobody carries the tag', () => {
    const p = tagged([card('a', 'open', { tags: ['ready'] })], new Set(['a']))
    expect(p.dispatch).toEqual([])
    expect(p.idleReason).toContain('excluded from the cohort')
  })

  test('an untagged board says nobody carries the tag', () => {
    expect(tagged([card('a', 'open', { tags: [] })]).idleReason).toContain('no card carries')
  })
})

describe('a ROUGH card is not ready -- the `needsRefine` precondition', () => {
  const rough = (slug: string, status: TaskStatus = 'open', extra: Partial<ProjectTaskMeta> = {}) =>
    card(slug, status, { epic: 'e1', ...extra, tags: [NEEDS_REFINE_TAG, ...(extra.tags ?? [])] })

  test('it is refused into a NAMED bucket, not silently dropped', () => {
    const p = plan([EPIC, rough('t1')])
    expect(p.dispatch).toEqual([])
    expect(p.needsRefine.map(c => c.slug)).toEqual(['t1'])
  })

  test('the refusal is countable and says which cards', () => {
    const p = plan([EPIC, rough('t1'), rough('t2')])
    expect(p.needsRefine.length).toBe(2)
    expect(p.idleReason).toContain(NEEDS_REFINE_TAG)
    expect(p.idleReason).toContain('t1, t2')
  })

  test('a clean sibling still dispatches -- one rough card does not stall the epic', () => {
    const p = plan([EPIC, rough('t1'), card('t2', 'open', { epic: 'e1' })])
    expect(p.dispatch.map(c => c.slug)).toEqual(['t2'])
    expect(p.needsRefine.map(c => c.slug)).toEqual(['t1'])
    expect(p.idleReason).toBeUndefined()
  })

  /**
   * THE POINT OF A PRECONDITION OVER AN ORDERING. The refiner may run before,
   * after, concurrently or never; drop the tag and the card is ready on the very
   * next fold, with nothing having had to run in sequence.
   */
  test('draining the tag makes the card ready, with no ordering required', () => {
    const before = plan([EPIC, rough('t1')])
    const after = plan([EPIC, card('t1', 'open', { epic: 'e1' })])
    expect(before.dispatch).toEqual([])
    expect(after.dispatch.map(c => c.slug)).toEqual(['t1'])
    expect(after.needsRefine).toEqual([])
  })

  test('roughness beats a dependency stall -- the reason reported is the actionable one', () => {
    const p = plan([EPIC, rough('t1', 'open', { dependsOn: ['nope'] })])
    expect(p.waitingOnDeps).toEqual([])
    expect(p.needsRefine.map(c => c.slug)).toEqual(['t1'])
  })

  /**
   * WITHHELD FROM `dispatch`, NOT FROM `verify`. `REFINER@1` is denied the status
   * verb, so a rough card blocked from the verify lane would sit in `in-review`
   * with nothing on the board able to move it.
   */
  test('an in-review card still gets its verdict', () => {
    const p = plan([EPIC, rough('t1', 'in-review')])
    expect(p.verify.map(c => c.slug)).toEqual(['t1'])
    expect(p.needsRefine.map(c => c.slug)).toEqual(['t1'])
  })

  test('a tag left on a finished card is history, not a stall', () => {
    const p = plan([EPIC, rough('t1', 'done'), rough('t2', 'archived')])
    expect(p.needsRefine).toEqual([])
    expect(p.idleReason).not.toContain(NEEDS_REFINE_TAG)
  })

  test('a question that is also rough is reported ONCE, as a question', () => {
    const p = plan([EPIC, rough('q1', 'open', { tags: [NEEDS_OVERSEER_TAG] })])
    expect(p.questions.map(c => c.slug)).toEqual(['q1'])
    expect(p.needsRefine).toEqual([])
    expect(p.idleReason).toContain('open question')
  })

  test('an unspawnable card outranks a rough one -- nothing else here stays broken on its own', () => {
    const p = planDead([EPIC, rough('t1'), card('t2', 'open', { epic: 'e1' })], ['t2'])
    expect(p.idleReason).toContain('seats keep dying')
  })

  test('the tag selector refuses a rough card too -- the precondition is not epic-only', () => {
    const p = planTagged({
      cards: [card('a', 'open', { tags: ['ready', NEEDS_REFINE_TAG] }), card('b', 'open', { tags: ['ready'] })],
      tag: 'ready',
      concurrency: 3,
      inFlight: [],
      inVerify: [],
    })
    expect(p.dispatch.map(c => c.slug)).toEqual(['b'])
    expect(p.needsRefine.map(c => c.slug)).toEqual(['a'])
  })
})

/**
 * THE SORT KEY (`epic-ready-slice-has-no-sort-key`).
 *
 * `ready.slice(0, slots)` had no sort key at all: the order was whatever order
 * the board happened to be enumerated in, and the ONLY thing that ever perturbed
 * it was `buildEpicIndex`'s bucket-then-priority sort -- which cannot settle a
 * tie between two `high` cards, and a tie between two `high` cards is exactly
 * what happened. `epic-digest-shares-run-frontmatter`, the head of a six-card
 * chain, was held back on four consecutive generations while
 * `runner-run-delete-verb` -- a leaf that blocks nothing, filed a day later and
 * therefore FIRST in an mtime-descending board read -- took the only free seat.
 *
 * These assert the fold end to end. The key itself is tested on its own in
 * `epic-ready-order.test.ts`.
 */
describe('dispatch order', () => {
  /** The head of a chain, plus the six cards that transitively wait on it. */
  const chain = (extra: Partial<ProjectTaskMeta> = {}) => [
    card('head', 'open', { epic: 'e1', priority: 'high', ...extra }),
    card('gen', 'open', { epic: 'e1', dependsOn: ['head'] }),
    card('lease', 'open', { epic: 'e1', dependsOn: ['gen'] }),
    card('atomic', 'open', { epic: 'e1', dependsOn: ['gen'] }),
    card('extend', 'open', { epic: 'e1', dependsOn: ['gen'] }),
    card('caps', 'open', { epic: 'e1', dependsOn: ['gen'] }),
    card('runstate', 'open', { epic: 'e1', dependsOn: ['lease', 'atomic', 'extend', 'caps'] }),
  ]

  /** The leaf is FIRST in board order, which is what an mtime-descending read of
   *  a board where the leaf was filed later actually looks like. Same priority on
   *  both, so priority cannot settle it -- that is the whole point. */
  const leafFirst = (extra: Partial<ProjectTaskMeta> = {}) => [
    EPIC,
    card('leaf', 'open', { epic: 'e1', priority: 'high' }),
    ...chain(extra),
  ]

  test('the head of the critical path beats a leaf that blocks nothing', () => {
    expect(plan(leafFirst(), 1).dispatch.map(c => c.slug)).toEqual(['head'])
  })

  test('heldBack is the complement under the SAME order, so the pane explains the choice', () => {
    const p = plan(leafFirst(), 1)
    expect(p.heldBack.map(c => c.slug)).toEqual(['leaf'])
  })

  /**
   * DO NOT MAKE IT PRIORITY-ONLY. A `high` leaf still blocks nothing; the DAG is
   * the primary key and the human's `priority:` is the tiebreak underneath it.
   */
  test('a high-priority leaf does NOT jump the low-priority head of the path', () => {
    expect(plan(leafFirst({ priority: 'low' }), 1).dispatch.map(c => c.slug)).toEqual(['head'])
  })

  test('priority still settles two cards that unblock nothing', () => {
    const p = plan(
      [EPIC, card('lo', 'open', { epic: 'e1', priority: 'low' }), card('hi', 'open', { epic: 'e1', priority: 'high' })],
      1,
    )
    expect(p.dispatch.map(c => c.slug)).toEqual(['hi'])
  })

  test('older work does not starve behind newer work of equal rank', () => {
    const p = plan(
      [
        EPIC,
        card('newer', 'open', { epic: 'e1', created: '2026-08-20T00:00:00.000Z' }),
        card('older', 'open', { epic: 'e1', created: '2026-08-01T00:00:00.000Z' }),
      ],
      1,
    )
    expect(p.dispatch.map(c => c.slug)).toEqual(['older'])
  })

  test('the tag selector is ordered by the same key -- readiness means one thing', () => {
    const p = planTagged({
      cards: [
        card('leaf', 'open', { tags: ['ready'] }),
        card('head', 'open', { tags: ['ready'] }),
        card('waiter', 'open', { dependsOn: ['head'] }),
      ],
      tag: 'ready',
      concurrency: 1,
      inFlight: [],
      inVerify: [],
    })
    expect(p.dispatch.map(c => c.slug)).toEqual(['head'])
  })
})
