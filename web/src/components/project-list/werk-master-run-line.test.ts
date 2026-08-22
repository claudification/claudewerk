/**
 * @vitest-environment node
 */
import type { RunVitality } from '@shared/epic-vitality'
import type { EpicActivityEntry } from '@shared/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetActivityCache, selectAllRuns, useWerkMasterActivityStore } from '@/hooks/use-werk-master-activity'
import { VITALITY_TONE } from './werk-master-vitality-tone'

const ALL_VITALITIES: RunVitality[] = ['working', 'idle', 'stalled', 'paused', 'done', 'aborted', 'unknown']

describe('VITALITY_TONE', () => {
  // The map is a Record, so a new enum member is a TYPE error at build time --
  // but only if this list is kept honest. Asserting on the values catches the
  // case where someone widens the type and reaches for a cast to shut it up.
  it('tones every vitality the shared derivation can produce', () => {
    for (const v of ALL_VITALITIES) {
      expect(VITALITY_TONE[v], `no tone for ${v}`).toBeTruthy()
    }
  })

  it('does not paint a stalled run the same as a working one', () => {
    expect(VITALITY_TONE.stalled).not.toBe(VITALITY_TONE.working)
  })
})

function entry(over: Partial<EpicActivityEntry>): EpicActivityEntry {
  return {
    epicId: 'epic-the-wall',
    project: 'claude:///Users/j/p',
    status: 'running',
    gen: 11,
    maxGens: 40,
    inFlight: 3,
    werkMasterAlive: true,
    armed: true,
    lastBeatAt: null,
    stale: false,
    ...over,
  }
}

describe('run lookup by epicId', () => {
  beforeEach(() => {
    resetActivityCache()
    useWerkMasterActivityStore.setState({ byProject: {}, primed: false })
  })

  // The reason this matches on epicId rather than indexing by project: an
  // werk-master's own conversation can live in a WORKTREE URI, which is a different
  // project key to the one the broker filed the run under. Indexing by the
  // conversation's project would find nothing for exactly the rows that need it.
  it('finds a run whose project key differs from the seat conversation URI', () => {
    useWerkMasterActivityStore.getState().applyProject('claude:///Users/j/p', [entry({})])
    const found = selectAllRuns(useWerkMasterActivityStore.getState()).find(r => r.epicId === 'epic-the-wall')
    expect(found?.gen).toBe(11)
  })

  it('keeps two epics in one project distinguishable', () => {
    useWerkMasterActivityStore
      .getState()
      .applyProject('claude:///Users/j/p', [entry({}), entry({ epicId: 'epic-the-wall-ii', gen: 3 })])
    const runs = selectAllRuns(useWerkMasterActivityStore.getState())
    expect(runs.find(r => r.epicId === 'epic-the-wall-ii')?.gen).toBe(3)
    expect(runs.find(r => r.epicId === 'epic-the-wall')?.gen).toBe(11)
  })

  it('returns nothing for an epic with no run artifact, rather than inventing one', () => {
    const runs = selectAllRuns(useWerkMasterActivityStore.getState())
    expect(runs.find(r => r.epicId === 'epic-nope')).toBeUndefined()
  })
})
