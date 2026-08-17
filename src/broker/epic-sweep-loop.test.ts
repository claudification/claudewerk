import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Conversation, EpicResult } from '../shared/protocol'
import { configureEpicIo, resetEpicIo } from './epic-executor'
import { resetSweepGuard, type SweepDeps, sweepEpics } from './epic-sweep-loop'

let beats: string[]
let log: string[]
let convs: Conversation[]
/** Resolves the in-flight `fetchEpicRun`, so a beat can be held mid-flight. */
let release: (() => void) | null

function conv(epicId: string, role: string, cardId?: string): Conversation {
  return {
    id: `conv_${epicId}_${cardId ?? role}`,
    project: `claude://s/${epicId}`,
    status: 'ended',
    launchConfig: { epic: { epicId, role, gen: 1, ...(cardId ? { cardId } : {}) } },
  } as unknown as Conversation
}

const deps = (): SweepDeps =>
  ({
    getAllConversations: () => convs,
    isLive: () => false,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => 0,
  }) as unknown as SweepDeps

beforeEach(() => {
  beats = []
  log = []
  convs = []
  release = null
  resetSweepGuard()
  configureEpicIo({
    fetchEpicRun: async (_d, project) => {
      beats.push(project)
      if (release) await new Promise<void>(r => (release = r))
      return { run: null, baton: [], error: 'no run in this test' }
    },
    fetchBoardCards: async () => [],
    appendBaton: async () => ({ type: 'epic_result', requestId: 'r', op: 'log_append', ok: true }) as EpicResult,
    sendEpicOp: async () => ({ type: 'epic_result', requestId: 'r', op: 'get', ok: true }) as EpicResult,
  })
})

afterEach(() => {
  resetEpicIo()
  resetSweepGuard()
})

describe('sweepEpics', () => {
  test('a board with no epic-tagged conversations does nothing at all', async () => {
    convs = [{ id: 'c1', project: 'p', status: 'ended' } as unknown as Conversation]
    await sweepEpics(deps())
    expect(beats).toHaveLength(0)
  })

  test('one beat per epic, not per conversation', async () => {
    convs = [conv('e1', 'implementer', 't1'), conv('e1', 'implementer', 't2'), conv('e2', 'implementer', 'x1')]
    await sweepEpics(deps())
    expect(beats).toHaveLength(2)
  })

  test('a beat that throws does not stop the other epics', async () => {
    convs = [conv('e1', 'implementer', 't1'), conv('e2', 'implementer', 'x1')]
    let first = true
    configureEpicIo({
      fetchEpicRun: async (_d, project) => {
        if (first) {
          first = false
          throw new Error('sentinel exploded')
        }
        beats.push(project)
        return { run: null, baton: [] }
      },
    })
    await sweepEpics(deps())
    expect(beats).toHaveLength(1)
    expect(log.join('\n')).toContain('sentinel exploded')
  })

  test('two ticks NEVER overlap -- the second is skipped while the first is in flight', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    release = () => {}
    const d = deps()
    const first = sweepEpics(d)
    await Promise.resolve()

    await sweepEpics(d) // fires while the first is still awaiting
    expect(log.join('\n')).toContain('previous tick still running')

    release?.()
    await first
    expect(beats).toHaveLength(1)
  })

  test('the guard clears after a tick, so the next one runs', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    await sweepEpics(deps())
    await sweepEpics(deps())
    expect(beats).toHaveLength(2)
  })

  test('the guard clears even when a beat threw', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    configureEpicIo({
      fetchEpicRun: async () => {
        throw new Error('boom')
      },
    })
    await sweepEpics(deps())
    configureEpicIo({
      fetchEpicRun: async (_d, project) => {
        beats.push(project)
        return { run: null, baton: [] }
      },
    })
    await sweepEpics(deps())
    expect(beats).toHaveLength(1)
  })
})
