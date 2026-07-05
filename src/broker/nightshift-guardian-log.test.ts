import { beforeEach, describe, expect, test } from 'bun:test'
import type { GuardianEvent } from '../shared/protocol'
import { __clearGuardianEventsForTest, getRecentGuardianEvents, recordGuardianEvent } from './nightshift-guardian-log'

function ev(over: Partial<GuardianEvent>): GuardianEvent {
  return {
    id: `gd-${Math.random()}`,
    at: 1,
    kind: 'poke',
    project: 'p',
    runId: 'r',
    taskId: 't',
    conversationId: 'c',
    reason: 'x',
    ...over,
  }
}

describe('guardian-log ring', () => {
  beforeEach(() => __clearGuardianEventsForTest())

  test('returns newest-first and filters by project + run', () => {
    recordGuardianEvent(ev({ project: 'a', runId: '1', at: 1 }))
    recordGuardianEvent(ev({ project: 'b', runId: '2', at: 2 }))
    recordGuardianEvent(ev({ project: 'a', runId: '1', at: 3 }))

    const all = getRecentGuardianEvents()
    expect(all.map(e => e.at)).toEqual([3, 2, 1]) // newest-first

    const a = getRecentGuardianEvents({ project: 'a' })
    expect(a).toHaveLength(2)
    expect(a.every(e => e.project === 'a')).toBe(true)

    expect(getRecentGuardianEvents({ project: 'a', runId: '2' })).toHaveLength(0)
    expect(getRecentGuardianEvents({ limit: 1 }).map(e => e.at)).toEqual([3])
  })
})
