import { describe, expect, test } from 'bun:test'
import { planEpic } from './epic-ready'
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
