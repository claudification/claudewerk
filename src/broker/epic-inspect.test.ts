import { afterEach, describe, expect, test } from 'bun:test'
import { RUN_AGE_OUT_MS } from '../shared/epic-run-cleared'
import type { EpicLaunchTag } from '../shared/epic-run-types'
import type { Conversation, EpicRunSnapshot } from '../shared/protocol'
import { recordBeat, resetBeatLog } from './epic-beat-log'
import { listEpicRuns } from './epic-inspect'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import type { SweepDeps } from './epic-sweep-loop'

/** The three forms of one project that the fleet actually produces: what the MCP
 *  caller types, what the pre-2026-04-25 `'claude:///' || cwd` concatenation
 *  left in the store, and what the canonical writers emit. */
const TYPED = 'claude:///Users/jonas/projects/remote-claude'
const SCARRED = 'claude:////Users/jonas/projects/remote-claude/'
const CANONICAL = 'claude://default/Users/jonas/projects/remote-claude'
const OTHER = 'claude:///Users/jonas/projects/elsewhere'

let n = 0
function conv(project: string, epicId: string): Conversation {
  n += 1
  const tag: EpicLaunchTag = { epicId, role: 'implementer', cardId: `c${n}`, gen: 1 } as EpicLaunchTag
  return { id: `conv_${n}`, project, launchConfig: { epic: tag } } as unknown as Conversation
}

/** No sentinel is connected, so `fetchEpicRun` resolves immediately with a
 *  failure view -- every row comes back with a null run. That is exactly the
 *  half these tests do not care about: the bug is which ids get enumerated. */
function deps(convs: Conversation[]): SweepDeps {
  return {
    getAllConversations: () => convs,
    isLive: () => true,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
  } as unknown as SweepDeps
}

afterEach(() => resetArmedEpics())

describe('listEpicRuns project matching', () => {
  test('a conversation stored under a differently-normalized URI is still listed', async () => {
    const rows = await listEpicRuns(deps([conv(SCARRED, 'e1')]), TYPED)
    expect(rows.map(r => r.epicId)).toEqual(['e1'])
  })

  test('the canonical authority form matches the empty-authority form', async () => {
    const rows = await listEpicRuns(deps([conv(CANONICAL, 'e1')]), TYPED)
    expect(rows.map(r => r.epicId)).toEqual(['e1'])
  })

  test('an ARMED run registered under a differently-normalized URI is still listed', async () => {
    noteArmedEpic(SCARRED, 'e2')
    const rows = await listEpicRuns(deps([]), TYPED)
    expect(rows.map(r => r.epicId)).toEqual(['e2'])
    expect(rows[0]?.armed).toBe(true)
  })

  test('a genuinely different project is still excluded', async () => {
    noteArmedEpic(OTHER, 'e3')
    const rows = await listEpicRuns(deps([conv(OTHER, 'e4')]), TYPED)
    expect(rows).toEqual([])
  })

  test('the same epic seen armed and live under two spellings is ONE row', async () => {
    noteArmedEpic(CANONICAL, 'e1')
    const rows = await listEpicRuns(deps([conv(SCARRED, 'e1')]), TYPED)
    expect(rows).toHaveLength(1)
  })

  test('the row echoes the project the CALLER asked about, not a rewritten one', async () => {
    const rows = await listEpicRuns(deps([conv(SCARRED, 'e1')]), TYPED)
    expect(rows[0]?.project).toBe(TYPED)
  })
})

/**
 * WHAT `list` SAYS ABOUT A RUN A HUMAN ALREADY BURIED.
 *
 * `clear` stamps `acknowledgedAt` and the wall's tail drops the row. `list` was
 * never told: it built its id set from conversations ∪ armed registry and
 * returned every one of them, so a run somebody explicitly acknowledged kept
 * coming back for as long as one of its conversations was still in the registry.
 * One fact, two surfaces, one of which was never told.
 *
 * MARKED, NOT HIDDEN -- see `EpicRunListEntry.cleared`. These tests pin that
 * choice as much as the arithmetic: a row that vanished from the ENUMERATION
 * surface would be a run nothing could name.
 */
describe('listEpicRuns burial', () => {
  const NOW = Date.parse('2026-08-21T12:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  /** One run view per epic, keyed by epic id. Anything unnamed comes back with a
   *  null run, exactly as an unreachable sentinel does. */
  function stubRuns(runs: Record<string, Partial<EpicRunSnapshot>>): void {
    configureEpicIo({
      fetchEpicRun: async (_deps, project, epicId) => ({
        run: runs[epicId] ? ({ epicId, project, ...runs[epicId] } as EpicRunSnapshot) : null,
        baton: [],
        acknowledgedCardIds: [],
        dispatchCounts: {},
        lease: null,
      }),
    })
  }

  afterEach(() => {
    resetEpicIo()
    resetBeatLog()
  })

  test('an ACKNOWLEDGED run is still enumerated, and says so', async () => {
    stubRuns({ e1: { status: 'aborted', updated: ago(60_000), acknowledgedAt: ago(30_000) } })
    const rows = await listEpicRuns(deps([conv(TYPED, 'e1')]), TYPED, NOW)
    expect(rows.map(r => r.epicId)).toEqual(['e1'])
    expect(rows[0]?.cleared).toBe('acknowledged')
    expect(rows[0]?.clearedAt).toBe(ago(30_000))
  })

  test('a run dead longer than the age-out gets the same treatment with no stamp', async () => {
    stubRuns({ e1: { status: 'paused', updated: ago(RUN_AGE_OUT_MS + 60_000) } })
    const rows = await listEpicRuns(deps([conv(TYPED, 'e1')]), TYPED, NOW)
    expect(rows[0]?.cleared).toBe('aged-out')
    expect(rows[0]?.clearedAt).toBe(ago(RUN_AGE_OUT_MS + 60_000))
  })

  test('a dead run nobody has acknowledged yet is NOT cleared', async () => {
    stubRuns({ e1: { status: 'aborted', updated: ago(60_000) } })
    const rows = await listEpicRuns(deps([conv(TYPED, 'e1')]), TYPED, NOW)
    expect(rows[0]?.cleared).toBeNull()
    expect(rows[0]?.clearedAt).toBeNull()
  })

  test('LIVENESS FIRST -- a running run carrying a stale stamp is never cleared', async () => {
    noteArmedEpic(TYPED, 'e1')
    stubRuns({ e1: { status: 'running', updated: ago(60_000), acknowledgedAt: ago(30_000) } })
    const rows = await listEpicRuns(deps([conv(TYPED, 'e1')]), TYPED, NOW)
    expect(rows[0]?.inFlight).toBe(1)
    expect(rows[0]?.cleared).toBeNull()
  })

  test('cleared rows sort LAST, and stay id-ordered within each half', async () => {
    stubRuns({
      a: { status: 'aborted', updated: ago(60_000), acknowledgedAt: ago(30_000) },
      b: { status: 'aborted', updated: ago(60_000) },
      c: { status: 'aborted', updated: ago(60_000), acknowledgedAt: ago(30_000) },
      d: { status: 'aborted', updated: ago(60_000) },
    })
    const rows = await listEpicRuns(deps(['a', 'b', 'c', 'd'].map(id => conv(TYPED, id))), TYPED, NOW)
    expect(rows.map(r => r.epicId)).toEqual(['b', 'd', 'a', 'c'])
  })

  test('a run with no artifact at all can never bury itself on an empty stamp', async () => {
    stubRuns({})
    const rows = await listEpicRuns(deps([conv(TYPED, 'e1')]), TYPED, NOW)
    expect(rows[0]?.status).toBeNull()
    expect(rows[0]?.cleared).toBeNull()
  })

  test('an artifact-less run ages out off its LAST BEAT, which is all it has', async () => {
    stubRuns({})
    recordBeat(
      TYPED,
      'e1',
      1,
      { epicId: 'e1', note: 'nothing', actions: 0, spawned: [] },
      NOW - RUN_AGE_OUT_MS - 60_000,
    )
    const rows = await listEpicRuns(deps([conv(TYPED, 'e1')]), TYPED, NOW)
    expect(rows[0]?.cleared).toBe('aged-out')
  })
})
