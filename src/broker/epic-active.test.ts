import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Conversation } from '../shared/protocol'
import { isCountedLive, listActiveEpicRuns, STALE_BEAT_MS } from './epic-active'
import { recordBeat, resetBeatLog } from './epic-beat-log'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import type { SweepDeps } from './epic-sweep-loop'

const PROJECT = 'claude://default/Users/jonas/projects/alpha'
const OTHER = 'claude://default/Users/jonas/projects/beta'
const NOW = Date.parse('2026-08-18T06:00:00.000Z')

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    project: PROJECT,
    status: 'active',
    launchConfig: { epic: { epicId: 'e1', role: 'implementer', cardId: 'c1', gen: 0 } },
    ...over,
  } as unknown as Conversation
}

/** A beat outcome with only the fields the ring's timestamp path cares about. */
const OUTCOME = { epicId: 'e1', note: '', actions: 0, spawned: [] }

/** Only the two members `listActiveEpicRuns` reads, plus the RPC seam below. */
function deps(convs: Conversation[] = []): SweepDeps {
  return {
    getAllConversations: () => convs,
    isLive: () => true,
    log: () => {},
  } as unknown as SweepDeps
}

/** The sentinel `get`, stubbed at the IO seam rather than with `mock.module`
 *  (which is process-global and would leak into every later test file). */
function stubRun(run: Record<string, unknown> | null) {
  configureEpicIo({
    fetchEpicRun: (async () => ({ run, baton: [], lease: null })) as never,
  })
}

beforeEach(() => {
  resetArmedEpics()
  resetBeatLog()
  resetEpicIo()
})

// The armed registry, the beat ring and the IO seam are all MODULE-GLOBAL, and
// bun runs every test file in one process. Cleaning up only on the way IN
// leaves the last case's state armed for whichever file runs next -- which is
// exactly how this suite broke epic-registry.test.ts's "nothing is armed to
// start with". Clean up on the way OUT too.
afterEach(() => {
  resetArmedEpics()
  resetBeatLog()
  resetEpicIo()
})

describe('listActiveEpicRuns', () => {
  test('unions the armed registry with conversation-derived groups', async () => {
    stubRun({ status: 'armed', gen: 0, maxGens: 40 })
    noteArmedEpic(OTHER, 'armed-only')

    const rows = await listActiveEpicRuns(deps([conv({ id: 'a' })]), NOW)

    expect(rows.map(r => r.epicId).sort()).toEqual(['armed-only', 'e1'])
  })

  test('an armed run with no conversations still reports -- the case the badge exists for', async () => {
    stubRun({ status: 'armed', gen: 0, maxGens: 40 })
    noteArmedEpic(PROJECT, 'fresh')

    const [row] = await listActiveEpicRuns(deps(), NOW)

    expect(row).toMatchObject({ epicId: 'fresh', status: 'armed', inFlight: 0, armed: true })
  })

  test('carries maxGens so a progress bar has a denominator', async () => {
    stubRun({ status: 'running', gen: 7, maxGens: 12 })
    noteArmedEpic(PROJECT, 'e1')

    const [row] = await listActiveEpicRuns(deps(), NOW)

    expect(row).toMatchObject({ gen: 7, maxGens: 12 })
  })

  test('a run whose last beat is older than two ticks is stale', async () => {
    stubRun({ status: 'running', gen: 1, maxGens: 10 })
    noteArmedEpic(PROJECT, 'e1')
    recordBeat(PROJECT, 'e1', 1, OUTCOME, NOW - STALE_BEAT_MS - 1000)

    const [row] = await listActiveEpicRuns(deps(), NOW)

    expect(row?.stale).toBe(true)
  })

  test('a run beating on cadence is not stale', async () => {
    stubRun({ status: 'running', gen: 1, maxGens: 10 })
    noteArmedEpic(PROJECT, 'e1')
    recordBeat(PROJECT, 'e1', 1, OUTCOME, NOW - 10_000)

    const [row] = await listActiveEpicRuns(deps(), NOW)

    expect(row?.stale).toBe(false)
    expect(row?.lastBeatAt).toBe(new Date(NOW - 10_000).toISOString())
  })

  test('a run that has never beaten is not stale -- it has not had the chance', async () => {
    stubRun({ status: 'armed', gen: 0, maxGens: 40 })
    noteArmedEpic(PROJECT, 'e1')

    const [row] = await listActiveEpicRuns(deps(), NOW)

    expect(row).toMatchObject({ lastBeatAt: null, stale: false })
  })

  test('one project failing does not erase the others from the feed', async () => {
    configureEpicIo({
      fetchEpicRun: (async (_d: unknown, project: string) => {
        if (project === OTHER) throw new Error('sentinel offline')
        return { run: { status: 'running', gen: 2, maxGens: 9 }, baton: [], lease: null }
      }) as never,
    })
    noteArmedEpic(PROJECT, 'good')
    noteArmedEpic(OTHER, 'bad')

    const rows = await listActiveEpicRuns(deps(), NOW)

    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.epicId === 'good')).toMatchObject({ status: 'running', gen: 2 })
    expect(rows.find(r => r.epicId === 'bad')).toMatchObject({ status: null, stale: true })
  })

  test('sorts by project then epic so the rail does not jitter between ticks', async () => {
    stubRun({ status: 'running', gen: 1, maxGens: 5 })
    noteArmedEpic(OTHER, 'zeta')
    noteArmedEpic(PROJECT, 'omega')
    noteArmedEpic(PROJECT, 'alpha')

    const rows = await listActiveEpicRuns(deps(), NOW)

    expect(rows.map(r => `${r.project.slice(-5)}/${r.epicId}`)).toEqual(['alpha/alpha', 'alpha/omega', '/beta/zeta'])
  })
})

describe('isCountedLive', () => {
  const row = { status: null } as Parameters<typeof isCountedLive>[0]

  test.each(['armed', 'running'])('%s makes the badge breathe', status => {
    expect(isCountedLive({ ...row, status } as never)).toBe(true)
  })

  test.each(['paused', 'complete', 'aborted', null])('%s does not', status => {
    expect(isCountedLive({ ...row, status } as never)).toBe(false)
  })
})
