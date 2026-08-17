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
const plan = (cards: ProjectTaskMeta[], concurrency = 3, inFlight: string[] = []) =>
  planEpic({ cards, epicId: 'e1', concurrency, inFlight })

describe('planEpic', () => {
  test('an epic nobody declared is reported, not crashed on', () => {
    const p = planEpic({ cards: [], epicId: 'ghost', concurrency: 3, inFlight: [] })
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
