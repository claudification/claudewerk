import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Conversation, EpicResult } from '../shared/protocol'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import {
  beatOneEpic,
  markEngineBoot,
  quarantineRemainingMs,
  RESTART_QUARANTINE_MS,
  resetSweepGuard,
  type SweepDeps,
  sweepEpics,
} from './epic-sweep-loop'

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
  resetArmedEpics()
  configureEpicIo({
    fetchEpicRun: async (_d, project) => {
      beats.push(project)
      if (release) await new Promise<void>(r => (release = r))
      return { run: null, baton: [], acknowledgedCardIds: [], lease: null, error: 'no run in this test' }
    },
    fetchBoardCards: async () => [],
    appendBaton: async () => ({ type: 'epic_result', requestId: 'r', op: 'log_append', ok: true }) as EpicResult,
    sendEpicOp: async () => ({ type: 'epic_result', requestId: 'r', op: 'get', ok: true }) as EpicResult,
  })
})

afterEach(() => {
  resetEpicIo()
  resetSweepGuard()
  resetArmedEpics()
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
        return { run: null, baton: [], acknowledgedCardIds: [], lease: null }
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
        return { run: null, baton: [], acknowledgedCardIds: [], lease: null }
      },
    })
    await sweepEpics(deps())
    expect(beats).toHaveLength(1)
  })
})

// THE BUG THE FIRST LIVE SMOKE FOUND (2026-08-18): the sweep discovered epics
// only from conversations, so a freshly armed run -- which has none -- was
// invisible, never dispatched, and therefore never got any. The engine could
// only find epics that were already running.
describe('an ARMED epic with no conversations yet', () => {
  test('still gets a beat', async () => {
    convs = []
    noteArmedEpic('claude://s/e1', 'e1')
    await sweepEpics(deps())
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('is beaten with an empty group -- nothing in flight, no overseer', async () => {
    convs = []
    noteArmedEpic('claude://s/e1', 'e1')
    await sweepEpics(deps())
    expect(beats).toHaveLength(1)
  })

  test('does NOT overwrite the conversation-derived group, which knows more', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    noteArmedEpic('claude://s/e1', 'e1')
    await sweepEpics(deps())
    // One beat, not two: the armed entry filled no gap.
    expect(beats).toHaveLength(1)
    expect(beats[0]).toBe('claude://s/e1')
  })

  test('several armed epics each get their own beat', async () => {
    convs = []
    noteArmedEpic('claude://s/e1', 'e1')
    noteArmedEpic('claude://s/e2', 'e2')
    await sweepEpics(deps())
    expect(beats).toHaveLength(2)
  })
})

describe('beatOneEpic -- the forced beat', () => {
  test('beats the named epic immediately, without waiting for the 45s tick', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    const res = await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(res.ok).toBe(true)
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('beats ONLY that epic, even when others have conversations', async () => {
    convs = [conv('e1', 'implementer', 't1'), conv('e2', 'implementer', 'x1')]
    await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('an epic the registry has never seen is still beaten, with an empty group', async () => {
    // This is the case right after arming: no conversations exist yet, and
    // refusing here would make the verb useless exactly when it is needed.
    convs = []
    const res = await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(res.ok).toBe(true)
    expect(beats).toHaveLength(1)
  })

  test('an armed epic is found through the registry, same as the sweep', async () => {
    convs = []
    noteArmedEpic('claude://s/e1', 'e1')
    await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('REFUSES while a scheduled sweep is mid-tick -- two beats would both dispatch the same ready card', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    release = () => {}
    const sweeping = sweepEpics(deps())
    const forced = await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(forced).toMatchObject({ ok: false })
    release?.()
    await sweeping
    // Exactly one beat ran: the forced one never started.
    expect(beats).toHaveLength(1)
  })

  test('releases the guard afterwards, so a second forced beat is not locked out', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    const second = await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(second.ok).toBe(true)
    expect(beats).toHaveLength(2)
  })

  test('releases the guard even when the beat THROWS -- a crash must not wedge the sweep forever', async () => {
    configureEpicIo({
      fetchEpicRun: async () => {
        throw new Error('sentinel exploded')
      },
    })
    const res = await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(res).toMatchObject({ ok: false, error: 'sentinel exploded' })
    // The guard is free again: a normal sweep still runs.
    configureEpicIo({
      fetchEpicRun: async (_d, project) => {
        beats.push(project)
        return { run: null, baton: [], acknowledgedCardIds: [], lease: null }
      },
    })
    convs = [conv('e1', 'implementer', 't1')]
    await sweepEpics(deps())
    expect(beats).toEqual(['claude://s/e1'])
  })
})

/**
 * A beat decides what to dispatch from "which conversations are live", and on a
 * fresh broker that answer is empty and wrong -- the agent hosts carrying the
 * seat tags are still reconnecting. Beat inside that window and every in-flight
 * card looks abandoned, so the engine dispatches a second seat for every one of
 * them: a duplicate fleet, on every deploy, with nobody watching.
 */
describe('the restart quarantine', () => {
  const at = (nowMs: number): SweepDeps => ({ ...deps(), now: () => nowMs })

  test('holds every beat for the first two minutes after the engine boots', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    markEngineBoot(0)
    await sweepEpics(at(60_000))
    expect(beats).toHaveLength(0)
    expect(log.join('\n')).toContain('restart quarantine')
  })

  test('says how much longer, so a held run is never mistaken for a stalled one', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    markEngineBoot(0)
    await sweepEpics(at(90_000))
    expect(log.join('\n')).toContain('30s more')
  })

  test('beats normally the moment the window closes', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    markEngineBoot(0)
    await sweepEpics(at(RESTART_QUARANTINE_MS))
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('a forced BEAT NOW is refused inside the window, with the reason and the wait', async () => {
    markEngineBoot(0)
    const res = await beatOneEpic(at(30_000), 'claude://s/e1', 'e1')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('still reconnecting')
    expect(res.ok === false && res.error).toContain('90s')
  })

  test('an unmarked engine is not quarantined -- a direct call is not a restart', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    await sweepEpics(deps())
    expect(beats).toEqual(['claude://s/e1'])
    expect(quarantineRemainingMs(0)).toBe(0)
  })

  test('the guard is not consumed by a quarantined tick', async () => {
    convs = [conv('e1', 'implementer', 't1')]
    markEngineBoot(0)
    await sweepEpics(at(1_000))
    await sweepEpics(at(RESTART_QUARANTINE_MS + 1))
    expect(beats).toEqual(['claude://s/e1'])
  })
})
