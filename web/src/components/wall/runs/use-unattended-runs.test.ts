/**
 * THE FEED HALF OF A7's LIVENESS RULE, driven against a REAL conversation store.
 *
 * `unattended-runs.test.tsx` mocks `useUnattendedRuns` wholesale and hands the
 * pane hand-built rows, so it proves what `run-liveness.ts` does with a
 * `liveWorkers: 0` -- and NOTHING about whether the feed can still produce one.
 * That is the half this card is named after: the second, disagreeing liveness
 * test used to live HERE, as
 *
 *     if (!tag || !conv.project || conv.status === 'ended') continue
 *
 * where the only answer it could give was "no row". Deleting it is requirement 1,
 * and until this file existed nothing failed if someone put it back.
 *
 * So these tests drive the real hook over a real `conversationsById`. Restore
 * that `continue` and three of the five below go red -- the run stops existing
 * instead of arriving as a dimmed row. That failure was reproduced, not assumed.
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Conversation, useConversationsStore } from '@/hooks/use-conversations'
import { useWerkMasterActivityStore } from '@/hooks/use-werk-master-activity'
import { rowLiveness } from './run-liveness'
import { type NightshiftRunRowData, useUnattendedRuns } from './use-unattended-runs'

const PROJECT = 'claude:///Users/j/remote-claude'

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    project: PROJECT,
    status: 'idle',
    startedAt: 0,
    capabilities: [],
    ...over,
  } as Conversation
}

/** A nightshift worker seat: the tag is what makes the run EXIST, the status is
 *  what used to decide -- wrongly, and in this file -- whether it was live. */
function worker(id: string, runId: string, status: Conversation['status']): Conversation {
  return conv({ id, status, nightshift: { runId, taskId: `task-${id}` } })
}

function nightRows(...convs: Conversation[]): NightshiftRunRowData[] {
  const conversationsById: Record<string, Conversation> = {}
  for (const c of convs) conversationsById[c.id] = c
  useConversationsStore.setState({ conversationsById })
  const { rows } = renderHook(() => useUnattendedRuns()).result.current
  return rows.filter((r): r is NightshiftRunRowData => r.kind === 'nightshift')
}

beforeEach(() => {
  useConversationsStore.setState({ conversationsById: {}, projectSettings: {}, connectSeq: 1 })
  // The epic half is not under test here, and a real `prime` would fetch.
  useWerkMasterActivityStore.setState({ byProject: {}, primed: true, prime: async () => true })
})

describe('useUnattendedRuns: the night feed reports workers, it does not judge liveness', () => {
  // THE REGRESSION TEST FOR REQUIREMENT 1. Put the `conv.status === 'ended'`
  // continue back in `use-unattended-runs.ts` and this one fails: `rows` comes
  // back empty, and a run nobody can see is exactly what O2 was chosen to stop.
  it('still returns a run whose every worker has ENDED, as liveWorkers: 0', () => {
    const rows = nightRows(worker('w1', '2026-08-14', 'ended'), worker('w2', '2026-08-14', 'ended'))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ runId: '2026-08-14', project: PROJECT, liveWorkers: 0 })
  })

  // ...and the row the feed produced is the one the pane calls EXPIRED. Asserted
  // here rather than trusted, so the feed and the liveness rule are pinned as ONE
  // path instead of two tests that each pass against a different shape.
  it('hands that row to run-liveness, which calls it EXPIRED and not live', () => {
    const [row] = nightRows(worker('w1', '2026-08-14', 'ended'))

    expect(rowLiveness(row)).toMatchObject({ live: false, label: 'EXPIRED', vitality: 'expired' })
  })

  it('counts only the workers that are still up when a run is half finished', () => {
    const rows = nightRows(
      worker('w1', '2026-08-19', 'ended'),
      worker('w2', '2026-08-19', 'running'),
      worker('w3', '2026-08-19', 'idle'),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].liveWorkers).toBe(2)
    expect(rowLiveness(rows[0])).toMatchObject({ live: true, label: 'RUNNING' })
  })

  it('keeps two runs apart, and lets one expire without touching the other', () => {
    const rows = nightRows(worker('w1', '2026-08-14', 'ended'), worker('w2', '2026-08-19', 'running')).sort((a, b) =>
      a.runId.localeCompare(b.runId),
    )

    expect(rows.map(r => [r.runId, r.liveWorkers])).toEqual([
      ['2026-08-14', 0],
      ['2026-08-19', 1],
    ])
  })

  it('ignores a conversation with no nightshift tag at all -- existence comes from the tag', () => {
    expect(nightRows(conv({ id: 'plain' }), conv({ id: 'dead', status: 'ended' }))).toEqual([])
  })
})
