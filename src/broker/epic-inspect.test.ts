import { afterEach, describe, expect, test } from 'bun:test'
import type { EpicLaunchTag } from '../shared/epic-run-types'
import type { Conversation } from '../shared/protocol'
import { listEpicRuns } from './epic-inspect'
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
