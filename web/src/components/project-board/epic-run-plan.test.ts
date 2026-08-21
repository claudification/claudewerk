/**
 * @vitest-environment node
 */
/**
 * The RUN dialog's numbers. These drive a decision to arm an unattended fleet,
 * so a wrong one is worse than no number at all.
 */

import type { EpicChild, EpicRollup } from '@shared/epic-cards'
import { describe, expect, it } from 'vitest'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { consequence, firstBeat, runPlan } from './epic-run-plan'

function child(slug: string, bucket: EpicChild['bucket'], waitingOn: string[] = []): EpicChild {
  return { card: { slug, title: slug, tags: [] } as unknown as ProjectTaskMeta, bucket, waitingOn }
}

function rollup(children: EpicChild[]): EpicRollup {
  const count = (b: EpicChild['bucket']) => children.filter(c => c.bucket === b).length
  return {
    epicId: 'werk-epic',
    card: null,
    children,
    notStarted: count('notStarted'),
    inProgress: count('inProgress'),
    done: count('done'),
    dropped: count('dropped'),
    total: children.length - count('dropped'),
    pct: null,
    complete: false,
  }
}

describe('runPlan', () => {
  it('splits the live cards by whether they can actually start', () => {
    const plan = runPlan(
      rollup([
        child('a', 'notStarted'),
        child('b', 'notStarted', ['a']),
        child('c', 'inProgress'),
        child('d', 'done'),
        child('e', 'dropped'),
      ]),
    )
    expect(plan).toEqual({ ready: 2, waiting: 1, done: 1, dropped: 1, live: 3 })
  })

  it('counts an in-progress card with an unmet dependency as WAITING, not ready', () => {
    // It is moving, but the engine still cannot dispatch against it this beat.
    expect(runPlan(rollup([child('a', 'inProgress', ['b'])]))).toMatchObject({ ready: 0, waiting: 1 })
  })

  it('reports an epic with nothing left to do as empty rather than guessing', () => {
    expect(runPlan(rollup([child('a', 'done'), child('b', 'dropped')]))).toMatchObject({ ready: 0, live: 0 })
  })
})

describe('firstBeat', () => {
  const plan = runPlan(rollup([child('a', 'notStarted'), child('b', 'notStarted'), child('c', 'notStarted', ['a'])]))

  it('is capped by the ready count, not by the concurrency you typed', () => {
    expect(firstBeat(plan, 5)).toBe(2)
  })

  it('is capped by concurrency when more cards are ready than slots', () => {
    expect(firstBeat(plan, 1)).toBe(1)
  })

  it('is zero when the whole epic is dependency-locked', () => {
    expect(firstBeat(runPlan(rollup([child('a', 'notStarted', ['x'])])), 3)).toBe(0)
  })
})

describe('consequence', () => {
  it('reads as one sentence about the combination, not three about the controls', () => {
    expect(consequence({ cadence: ['now'], target: 'merged', concurrency: 3, plan: false })).toBe(
      'Starts now, up to 3 at a time, and stops once each card is merged to main.',
    )
  })

  /** Planning happens BEFORE the cadence clause is true of anything, so it gets
   *  its own clause rather than being folded into "starts now". */
  it('leads with the planning generation when one is owed', () => {
    expect(consequence({ cadence: ['now'], target: 'merged', concurrency: 3, plan: true })).toBe(
      'Plans the epic first, then: starts now, up to 3 at a time, and stops once each card is merged to main.',
    )
  })

  it('says UP TO, because concurrency is a ceiling and not a promise of three', () => {
    // The engine dispatches min(ready, concurrency). Reading "3 at a time" as a
    // commitment to three is how a 1-ready epic looks broken.
    expect(consequence({ cadence: ['now'], target: 'pr', concurrency: 5, plan: false })).toContain('up to 5 at a time')
  })

  it('does not say "1 at a time"', () => {
    expect(consequence({ cadence: ['window'], target: 'shipped', concurrency: 1, plan: false })).toBe(
      "Starts in the project's night window, one card at a time, and does not stop until it is deployed.",
    )
  })

  it('says what QUEUE actually commits you to, which is exclusivity', () => {
    const s = consequence({ cadence: ['queue'], target: 'merged', concurrency: 3, plan: false })
    expect(s).toContain('no other epic in this project is running')
    expect(s).toContain('exclusively')
  })

  /** ALL the gates must pass, so the sentence has to state all of them -- one
   *  that showed only the first would describe a run that does not exist. */
  it('joins a composed axis rather than describing half of it', () => {
    const s = consequence({ cadence: ['window', 'queue'], target: 'merged', concurrency: 3, plan: false })
    expect(s).toContain('night window, and waits until no other epic')
  })
})
