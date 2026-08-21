/**
 * THE QUEUE GATE, as arithmetic.
 *
 * Every case here is a cross-epic question, which is exactly why the fold is its
 * own pure function: none of it needs a broker, a sentinel, a board or a spawn,
 * and the failures worth catching (two queued epics entering together, a queued
 * epic that never enters, a held epic that never drains) are all decisions.
 */

import { describe, expect, it } from 'bun:test'
import { QUEUE_PATIENCE_MS, type QueueScope, queueVerdicts } from './epic-queue'

const T0 = Date.parse('2026-08-21T10:00:00.000Z')

function scope(over: Partial<QueueScope> & { epicId: string }): QueueScope {
  return {
    when: ['now'],
    status: 'armed',
    started: false,
    busy: false,
    created: '2026-08-21T09:00:00.000Z',
    updated: '2026-08-21T09:00:00.000Z',
    ...over,
  }
}

const verdict = (scopes: QueueScope[], id: string, nowMs = T0) => {
  const v = queueVerdicts(scopes, nowMs).get(id)
  if (!v) throw new Error(`no verdict for ${id}`)
  return v
}

describe('a queued epic waits for the runner', () => {
  const busyNeighbour = scope({ epicId: 'epic-morning-report', status: 'running', started: true, busy: true })
  const queued = scope({ epicId: 'epic-project-runner', when: ['queue'] })

  it('is blocked while another epic has work in flight', () => {
    const v = verdict([busyNeighbour, queued], 'epic-project-runner')
    expect(v.blocked).toBe(true)
    expect(v.behind).toEqual(['epic-morning-report'])
  })

  it('reports its QUEUE POSITION rather than just "armed, nothing happening"', () => {
    const second = scope({
      epicId: 'epic-scanner-fabric',
      when: ['queue'],
      created: '2026-08-21T09:30:00.000Z',
    })
    const v = verdict([busyNeighbour, queued, second], 'epic-scanner-fabric')
    expect(v.position).toBe(2)
    expect(v.total).toBe(2)
    expect(v.reason).toContain('position 2 of 2')
    expect(v.reason).toContain('epic-morning-report')
  })

  it('dispatches on the first beat after the other epic goes idle', () => {
    const idleNeighbour = { ...busyNeighbour, busy: false }
    const v = verdict([idleNeighbour, queued], 'epic-project-runner')
    expect(v.blocked).toBe(false)
  })

  it('ignores a paused or finished neighbour -- an inert run holds nothing', () => {
    const paused = scope({ epicId: 'epic-the-wall-ii', status: 'paused', busy: true, started: true })
    expect(verdict([paused, queued], 'epic-project-runner').blocked).toBe(false)
  })

  it('lets exactly ONE of two queued epics in, FIFO by arm time', () => {
    const first = scope({ epicId: 'epic-a', when: ['queue'], created: '2026-08-21T09:00:00.000Z' })
    const second = scope({ epicId: 'epic-b', when: ['queue'], created: '2026-08-21T09:05:00.000Z' })
    expect(verdict([first, second], 'epic-a').blocked).toBe(false)
    expect(verdict([second, first], 'epic-b').blocked).toBe(true)
    expect(verdict([first, second], 'epic-b').behind).toEqual(['epic-a'])
  })

  it('says STARVING once the wait stops looking like scheduling', () => {
    const stale = { ...queued, updated: new Date(T0 - QUEUE_PATIENCE_MS - 60_000).toISOString() }
    const v = verdict([busyNeighbour, stale], 'epic-project-runner')
    expect(v.reason).toContain('STARVING')
    expect(v.waitingMs).toBeGreaterThanOrEqual(QUEUE_PATIENCE_MS)
  })

  it('never reports a NaN wait when the artifact carries no stamp', () => {
    const undated = { ...queued, updated: '' }
    expect(verdict([busyNeighbour, undated], 'epic-project-runner').waitingMs).toBe(0)
  })
})

describe('a queued epic that entered holds the runner exclusively', () => {
  const holder = scope({ epicId: 'epic-project-runner', when: ['queue'], status: 'running', started: true })
  const neighbour = scope({ epicId: 'epic-morning-report', status: 'running' })

  it('holds even on a beat where nothing of its own is in flight', () => {
    const v = verdict([holder, neighbour], 'epic-project-runner')
    expect(v.blocked).toBe(false)
    expect(v.reason).toContain('holding the runner')
  })

  it('blocks every OTHER epic from dispatching while it holds', () => {
    const v = verdict([holder, neighbour], 'epic-morning-report')
    expect(v.blocked).toBe(true)
    expect(v.heldBy).toBe('epic-project-runner')
  })

  it('releases the moment it goes inert -- going dry PARKS the run', () => {
    const parked = { ...holder, status: 'paused' as const }
    expect(verdict([parked, neighbour], 'epic-morning-report').blocked).toBe(false)
  })

  it('does not block itself', () => {
    expect(verdict([holder], 'epic-project-runner').blocked).toBe(false)
  })
})

describe('an epic on no queue is untouched by the axis', () => {
  it('is free while nothing is queued, however busy the project is', () => {
    const a = scope({ epicId: 'epic-a', busy: true, status: 'running', started: true })
    const b = scope({ epicId: 'epic-b', busy: true, status: 'running', started: true })
    expect(verdict([a, b], 'epic-a')).toEqual({ blocked: false, position: 0, total: 0, behind: [], reason: null })
  })

  it('is free while a queued epic is still WAITING -- arming one blocks nothing', () => {
    const waiting = scope({ epicId: 'epic-queued', when: ['queue'] })
    const busy = scope({ epicId: 'epic-a', busy: true, status: 'running', started: true })
    expect(verdict([waiting, busy], 'epic-a').blocked).toBe(false)
  })
})
