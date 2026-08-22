/**
 * THE LANDING GATE, at the level the arithmetic happens: `done` is a lane, not a
 * git fact, and a dependent must not dispatch onto a base missing the work it was
 * sequenced behind.
 *
 * Its own file rather than more of `epic-ready.test.ts` (755 lines already), and
 * the split is the one that file's own subject suggests: everything here is about
 * a fact that comes from OUTSIDE the board.
 */

import { describe, expect, test } from 'bun:test'
import type { CardLanding } from './epic-landing'
import { planEpic } from './epic-ready'
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
    created: '2026-08-22T10:00:00Z',
    mtime: seq,
    bodyPreview: '',
    ...extra,
  }
}

const EPIC = card('e1', 'open', { tags: ['epic'] })

const landing = (cardId: string, verdict: CardLanding['verdict']): CardLanding => ({
  cardId,
  branch: `worktree-epic/e1/${cardId}`,
  verdict,
  evidence: verdict === 'unmerged' ? 'ahead' : 'merged',
})

const plan = (cards: ProjectTaskMeta[], landings: CardLanding[] = []) =>
  planEpic({ cards, epicId: 'e1', concurrency: 3, inFlight: [], inVerify: [], landings })

describe('a `done` dependency whose work never reached main', () => {
  const board = [EPIC, card('dep', 'done', { epic: 'e1' }), card('child', 'open', { epic: 'e1', dependsOn: ['dep'] })]

  test('WITHOUT the gate the dependent dispatches -- the failure, reproduced', () => {
    // This is what stranded 34 branches on 2026-08-22: every card read `done`,
    // and their dependents went out onto a base that did not carry the work.
    expect(plan(board).dispatch.map(c => c.slug)).toEqual(['child'])
  })

  test('WITH the gate the dependent waits, naming the dependency', () => {
    const p = plan(board, [landing('dep', 'unmerged')])
    expect(p.dispatch).toEqual([])
    expect(p.waitingOnDeps.map(w => [w.card.slug, w.waitingOn])).toEqual([['child', ['dep']]])
  })

  test('the hold lifts the moment git says the commit is on main -- nothing to un-set', () => {
    // DERIVED, never stored. There is no mark to clear and no artifact to
    // hand-edit: a landed verdict simply stops holding.
    expect(plan(board, [landing('dep', 'landed')]).dispatch.map(c => c.slug)).toEqual(['child'])
  })

  test('a merged-but-not-cleaned-up dependency does NOT hold its dependents', () => {
    // The dependent's problem is a missing base, and a standing branch's code
    // is in main. Holding work for a `rm -rf` would be a whole-run stall over
    // tidiness -- `standing` refuses COMPLETION instead (below).
    expect(plan(board, [landing('dep', 'standing')]).dispatch.map(c => c.slug)).toEqual(['child'])
  })
})

describe('the hold is PER DEPENDENCY CHAIN, never a whole-run freeze', () => {
  test('cards on unrelated branches of the DAG keep dispatching throughout', () => {
    const p = plan(
      [
        EPIC,
        card('dep', 'done', { epic: 'e1' }),
        card('blocked', 'open', { epic: 'e1', dependsOn: ['dep'] }),
        card('elsewhere', 'open', { epic: 'e1' }),
        card('other-chain', 'open', { epic: 'e1', dependsOn: ['elsewhere'] }),
      ],
      [landing('dep', 'unmerged')],
    )
    expect(p.dispatch.map(c => c.slug)).toEqual(['elsewhere'])
    expect(p.waitingOnDeps.map(w => w.card.slug).sort()).toEqual(['blocked', 'other-chain'])
  })

  test('a card that depends on the unlanded one TRANSITIVELY is held by its own direct dep, as always', () => {
    const p = plan(
      [
        EPIC,
        card('dep', 'done', { epic: 'e1' }),
        card('mid', 'open', { epic: 'e1', dependsOn: ['dep'] }),
        card('tail', 'open', { epic: 'e1', dependsOn: ['mid'] }),
      ],
      [landing('dep', 'unmerged')],
    )
    expect(p.dispatch).toEqual([])
    expect(p.waitingOnDeps.find(w => w.card.slug === 'tail')?.waitingOn).toEqual(['mid'])
  })

  test('an unlanded card that nothing depends on holds no dispatch at all', () => {
    const p = plan(
      [EPIC, card('lonely', 'done', { epic: 'e1' }), card('free', 'open', { epic: 'e1' })],
      [landing('lonely', 'unmerged')],
    )
    expect(p.dispatch.map(c => c.slug)).toEqual(['free'])
  })

  test('a dependency named twice is not listed twice', () => {
    const p = plan(
      [
        EPIC,
        card('a', 'open', { epic: 'e1' }),
        card('b', 'done', { epic: 'e1' }),
        card('c', 'open', { epic: 'e1', dependsOn: ['a', 'b'] }),
      ],
      [landing('b', 'unmerged')],
    )
    expect(p.waitingOnDeps.find(w => w.card.slug === 'c')?.waitingOn).toEqual(['a', 'b'])
  })
})

describe('completion', () => {
  const finished = [EPIC, card('t1', 'done', { epic: 'e1' }), card('t2', 'done', { epic: 'e1' })]

  test('every child terminal AND delivered completes', () => {
    expect(plan(finished, [landing('t1', 'landed'), landing('t2', 'landed')]).complete).toBe(true)
  })

  test('an unmerged branch REFUSES the run its completion', () => {
    const p = plan(finished, [landing('t1', 'landed'), landing('t2', 'unmerged')])
    expect(p.complete).toBe(false)
    expect(p.unlanded.map(l => l.cardId)).toEqual(['t2'])
  })

  test('a branch left standing refuses it too -- resolved means merged AND cleaned up', () => {
    expect(plan(finished, [landing('t1', 'landed'), landing('t2', 'standing')]).complete).toBe(false)
  })

  test('with no landings supplied at all the plan behaves exactly as it did before', () => {
    // ABSENT MEANS NO GATE: a caller with no commit ledger to ask dispatches as
    // it always did rather than withholding work on evidence nobody supplied.
    const p = plan(finished)
    expect(p.complete).toBe(true)
    expect(p.unlanded).toEqual([])
  })
})

describe('idleReason', () => {
  test('names the cards and their branches, above every other reason', () => {
    const p = plan(
      [
        EPIC,
        card('dep', 'done', { epic: 'e1' }),
        card('child', 'open', { epic: 'e1', dependsOn: ['dep'] }),
        card('rough', 'open', { epic: 'e1', tags: ['needs-refine'] }),
      ],
      [landing('dep', 'unmerged')],
    )
    // Every other entry in the idle table is a disagreement the board can be read
    // to discover. This one is the board being WRONG, so it outranks them.
    expect(p.idleReason).toContain('worktree-epic/e1/dep')
    expect(p.idleReason).not.toContain('needs-refine')
  })
})
