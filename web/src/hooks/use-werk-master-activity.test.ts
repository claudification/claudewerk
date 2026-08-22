/**
 * @vitest-environment node
 */
import type { EpicActivityEntry } from '@shared/protocol'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  isLiveRun,
  resetActivityCache,
  selectAllRuns,
  selectAllStale,
  selectLiveCount,
  selectMinGen,
  selectSeatCount,
  useWerkMasterActivityStore,
} from './use-werk-master-activity'

const ALPHA = 'claude://default/Users/jonas/projects/alpha'
const BETA = 'claude://default/Users/jonas/projects/beta'

function row(over: Partial<EpicActivityEntry> & { epicId: string }): EpicActivityEntry {
  return {
    project: ALPHA,
    status: 'running',
    gen: 1,
    maxGens: 10,
    inFlight: 2,
    werkMasterAlive: false,
    armed: true,
    lastBeatAt: null,
    stale: false,
    ...over,
  }
}

beforeEach(() => {
  useWerkMasterActivityStore.setState({ byProject: {}, primed: false })
  resetActivityCache()
})

const apply = (project: string, rows: EpicActivityEntry[]) =>
  useWerkMasterActivityStore.getState().applyProject(project, rows)

describe('applyProject', () => {
  test('REPLACES a project slice rather than merging it', () => {
    apply(ALPHA, [row({ epicId: 'a' }), row({ epicId: 'b' })])
    apply(ALPHA, [row({ epicId: 'b' })])

    expect(selectAllRuns(useWerkMasterActivityStore.getState()).map(r => r.epicId)).toEqual(['b'])
  })

  test('an empty array clears that project -- the settle signal, not a no-op', () => {
    apply(ALPHA, [row({ epicId: 'a' })])
    apply(ALPHA, [])

    expect(selectAllRuns(useWerkMasterActivityStore.getState())).toEqual([])
  })

  test('one project clearing leaves the others alone', () => {
    apply(ALPHA, [row({ epicId: 'a' })])
    apply(BETA, [row({ epicId: 'b', project: BETA })])
    apply(ALPHA, [])

    expect(selectAllRuns(useWerkMasterActivityStore.getState()).map(r => r.epicId)).toEqual(['b'])
  })

  test('clearing a project that was never there does not churn state', () => {
    const before = useWerkMasterActivityStore.getState().byProject
    apply(ALPHA, [])

    expect(useWerkMasterActivityStore.getState().byProject).toBe(before)
  })
})

describe('selectAllRuns', () => {
  test('returns a STABLE identity while the map is unchanged', () => {
    apply(ALPHA, [row({ epicId: 'a' })])
    const state = useWerkMasterActivityStore.getState()

    expect(selectAllRuns(state)).toBe(selectAllRuns(state))
  })

  test('returns a new value once the map changes', () => {
    apply(ALPHA, [row({ epicId: 'a' })])
    const first = selectAllRuns(useWerkMasterActivityStore.getState())
    apply(BETA, [row({ epicId: 'b', project: BETA })])

    expect(selectAllRuns(useWerkMasterActivityStore.getState())).not.toBe(first)
  })
})

describe('badge selectors', () => {
  test('count only live runs; paused and complete do not make it breathe', () => {
    apply(ALPHA, [row({ epicId: 'a' }), row({ epicId: 'b', status: 'paused' }), row({ epicId: 'c', status: 'armed' })])

    expect(selectLiveCount(useWerkMasterActivityStore.getState())).toBe(2)
  })

  test('seats sum only across LIVE runs', () => {
    apply(ALPHA, [row({ epicId: 'a', inFlight: 2 }), row({ epicId: 'b', status: 'paused', inFlight: 9 })])

    expect(selectSeatCount(useWerkMasterActivityStore.getState())).toBe(2)
  })

  test('gen reports the laggard, which is the informative one', () => {
    apply(ALPHA, [row({ epicId: 'a', gen: 7 }), row({ epicId: 'b', gen: 2 })])

    expect(selectMinGen(useWerkMasterActivityStore.getState())).toBe(2)
  })

  test('one healthy run among stalled ones is still motion', () => {
    apply(ALPHA, [row({ epicId: 'a', stale: true }), row({ epicId: 'b', stale: false })])

    expect(selectAllStale(useWerkMasterActivityStore.getState())).toBe(false)
  })

  test('every live run quiet means the pip must freeze', () => {
    apply(ALPHA, [row({ epicId: 'a', stale: true }), row({ epicId: 'b', stale: true })])

    expect(selectAllStale(useWerkMasterActivityStore.getState())).toBe(true)
  })

  test('nothing running is not stale -- there is nothing to have gone quiet', () => {
    expect(selectAllStale(useWerkMasterActivityStore.getState())).toBe(false)
  })
})

describe('isLiveRun', () => {
  test.each(['armed', 'running'] as const)('%s is live', status => {
    expect(isLiveRun(row({ epicId: 'a', status }))).toBe(true)
  })

  test.each(['paused', 'complete', 'aborted', null] as const)('%s is not', status => {
    expect(isLiveRun(row({ epicId: 'a', status }))).toBe(false)
  })
})
