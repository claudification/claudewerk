import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BranchFabric, Conversation, EpicResult } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import {
  beatOneEpic,
  buildSweepDeps,
  markEngineBoot,
  quarantineRemainingMs,
  RESTART_QUARANTINE_MS,
  resetSweepGuard,
  resolveBeatGroup,
  type SweepDeps,
  sweepEpics,
  toGitDirt,
} from './epic-sweep-loop'
import { NO_REAPING, SEAT_SILENCE_MS, WERK_MASTER_SILENCE_MS } from './epic-vitality'

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
      return {
        run: null,
        baton: [],
        acknowledgedCardIds: [],
        dispatchCounts: {},
        lease: null,
        error: 'no run in this test',
      }
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
    convs = [conv('e1', 'werk-worker', 't1'), conv('e1', 'werk-worker', 't2'), conv('e2', 'werk-worker', 'x1')]
    await sweepEpics(deps())
    expect(beats).toHaveLength(2)
  })

  test('a beat that throws does not stop the other epics', async () => {
    convs = [conv('e1', 'werk-worker', 't1'), conv('e2', 'werk-worker', 'x1')]
    let first = true
    configureEpicIo({
      fetchEpicRun: async (_d, project) => {
        if (first) {
          first = false
          throw new Error('sentinel exploded')
        }
        beats.push(project)
        return { run: null, baton: [], acknowledgedCardIds: [], dispatchCounts: {}, lease: null }
      },
    })
    await sweepEpics(deps())
    expect(beats).toHaveLength(1)
    expect(log.join('\n')).toContain('sentinel exploded')
  })

  test('two ticks NEVER overlap -- the second is skipped while the first is in flight', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
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
    convs = [conv('e1', 'werk-worker', 't1')]
    await sweepEpics(deps())
    await sweepEpics(deps())
    expect(beats).toHaveLength(2)
  })

  test('the guard clears even when a beat threw', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    configureEpicIo({
      fetchEpicRun: async () => {
        throw new Error('boom')
      },
    })
    await sweepEpics(deps())
    configureEpicIo({
      fetchEpicRun: async (_d, project) => {
        beats.push(project)
        return { run: null, baton: [], acknowledgedCardIds: [], dispatchCounts: {}, lease: null }
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

  test('is beaten with an empty group -- nothing in flight, no werk-master', async () => {
    convs = []
    noteArmedEpic('claude://s/e1', 'e1')
    await sweepEpics(deps())
    expect(beats).toHaveLength(1)
  })

  test('does NOT overwrite the conversation-derived group, which knows more', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
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
    convs = [conv('e1', 'werk-worker', 't1')]
    const res = await beatOneEpic(deps(), 'claude://s/e1', 'e1')
    expect(res.ok).toBe(true)
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('beats ONLY that epic, even when others have conversations', async () => {
    convs = [conv('e1', 'werk-worker', 't1'), conv('e2', 'werk-worker', 'x1')]
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
    convs = [conv('e1', 'werk-worker', 't1')]
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
    convs = [conv('e1', 'werk-worker', 't1')]
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
        return { run: null, baton: [], acknowledgedCardIds: [], dispatchCounts: {}, lease: null }
      },
    })
    convs = [conv('e1', 'werk-worker', 't1')]
    await sweepEpics(deps())
    expect(beats).toEqual(['claude://s/e1'])
  })
})

/**
 * BEAT NOW runs the same dispatch the sweep does, off a group it looks up by
 * project. The RPC caller types `claude:///path`; the conversation store holds
 * `claude://default/path`. Raw string equality made the lookup MISS and the `??`
 * fall through to a synthetic empty group -- so every seat-ceiling check inside
 * the beat saw zero seats and a manual beat could re-dispatch a card that
 * already had a live werk-worker on it.
 */
describe('beatOneEpic -- the project URI is matched by identity, not by spelling', () => {
  /** What the store holds. */
  const STORED = 'claude://default/Users/jonas/projects/alpha'
  /** What the RPC caller types. Same project, other spelling. */
  const TYPED = 'claude:///Users/jonas/projects/alpha'

  const seat = (): Conversation =>
    ({
      id: 'conv_live_t1',
      project: STORED,
      status: 'active',
      launchConfig: { epic: { epicId: 'e1', role: 'werk-worker', cardId: 't1', gen: 1 } },
    }) as unknown as Conversation

  /** `inFlight` is the LIVE half of the card lanes, so the seat has to be live. */
  const live = (): SweepDeps => ({ ...deps(), isLive: () => true })

  test('resolves the REAL group -- the synthetic one hides every live seat from the ceiling', () => {
    convs = [seat()]
    expect(resolveBeatGroup(live(), TYPED, 'e1').inFlight).toEqual(['t1'])
  })

  test('beats against the group the sweep would beat, carrying the STORE spelling onward', async () => {
    convs = [seat()]
    const res = await beatOneEpic(live(), TYPED, 'e1')
    expect(res.ok).toBe(true)
    expect(beats).toEqual([STORED])
  })

  test('an epic nobody has seen yet still gets an empty group -- the case right after arming', () => {
    convs = []
    expect(resolveBeatGroup(deps(), TYPED, 'ghost')).toMatchObject({
      epicId: 'ghost',
      project: TYPED,
      inFlight: [],
      werkMasterAlive: false,
      maxGenSeen: 0,
    })
  })

  test('a DIFFERENT project with the same epic id is still a miss', () => {
    convs = [seat()]
    expect(resolveBeatGroup(live(), 'claude:///Users/jonas/projects/beta', 'e1').inFlight).toEqual([])
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
    convs = [conv('e1', 'werk-worker', 't1')]
    markEngineBoot(0)
    await sweepEpics(at(60_000))
    expect(beats).toHaveLength(0)
    expect(log.join('\n')).toContain('restart quarantine')
  })

  test('says how much longer, so a held run is never mistaken for a stalled one', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    markEngineBoot(0)
    await sweepEpics(at(90_000))
    expect(log.join('\n')).toContain('30s more')
  })

  test('beats normally the moment the window closes', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
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
    convs = [conv('e1', 'werk-worker', 't1')]
    await sweepEpics(deps())
    expect(beats).toEqual(['claude://s/e1'])
    expect(quarantineRemainingMs(0)).toBe(0)
  })

  test('the guard is not consumed by a quarantined tick', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    markEngineBoot(0)
    await sweepEpics(at(1_000))
    await sweepEpics(at(RESTART_QUARANTINE_MS + 1))
    expect(beats).toEqual(['claude://s/e1'])
  })
})

// THE PER-PROJECT OPT-IN. Off by default, every scanner, every project -- and
// checked HERE, by the caller, never by the scanner.
describe('the "epics" opt-in gate', () => {
  /** A gate that says yes to exactly the projects named, and records its stamps. */
  const gated = (...on: string[]): { deps: SweepDeps; stamps: Array<[string, number]> } => {
    const stamps: Array<[string, number]> = []
    const enabled = new Set(on)
    return {
      deps: {
        ...deps(),
        scannerOptIn: {
          projects: () => [...enabled],
          enabled: (project: string) => enabled.has(project),
          stamp: (project: string, at: number) => void stamps.push([project, at]),
        },
      },
      stamps,
    }
  }

  test('a project with the box unticked is swept by nothing', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    await sweepEpics(gated().deps)
    expect(beats).toHaveLength(0)
  })

  test('and says so, naming the project and where to tick it', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    await sweepEpics(gated().deps)
    expect(log.join('\n')).toContain('claude://s/e1')
    expect(log.join('\n')).toContain('Project Settings > Scanners')
  })

  test('a project with the box ticked is swept exactly as before', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    await sweepEpics(gated('claude://s/e1').deps)
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('gates PER PROJECT -- one opted in, one not, in the same tick', async () => {
    convs = [conv('e1', 'werk-worker', 't1'), conv('e2', 'werk-worker', 'x1')]
    await sweepEpics(gated('claude://s/e1').deps)
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('an armed run in an opted-out project is dropped, not beaten', async () => {
    // The hole a conversation filter alone would leave: `epicsToWatch` unions the
    // armed registry, which no dep reaches.
    convs = []
    noteArmedEpic('claude://s/e1', 'e1')
    await sweepEpics(gated().deps)
    expect(beats).toHaveLength(0)
    expect(log.join('\n')).toContain('dropped armed epic e1')
  })

  test('an armed run in an opted-IN project is still beaten', async () => {
    convs = []
    noteArmedEpic('claude://s/e1', 'e1')
    await sweepEpics(gated('claude://s/e1').deps)
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('absent gate means no gate -- the sweep runs everywhere', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    await sweepEpics(deps())
    expect(beats).toEqual(['claude://s/e1'])
  })

  test('stamps last-run for every opted-in project, including the empty ones', async () => {
    // The whole value of the stamp: an enabled project with no epic at all still
    // proves the loop is alive, which is what "last ran never" would deny.
    convs = []
    const g = gated('claude://s/quiet')
    await sweepEpics(g.deps)
    expect(g.stamps).toEqual([['claude://s/quiet', 0]])
  })

  test('stamps nothing when no project opted in -- the default state writes zero times', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    const g = gated()
    await sweepEpics(g.deps)
    expect(g.stamps).toEqual([])
  })

  test('a forced BEAT NOW is refused for an opted-out project, naming the box', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    const res = await beatOneEpic(gated().deps, 'claude://s/e1', 'e1')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('Project Settings > Scanners')
    expect(beats).toHaveLength(0)
  })

  test('a forced BEAT NOW still works for an opted-in project', async () => {
    convs = [conv('e1', 'werk-worker', 't1')]
    const res = await beatOneEpic(gated('claude://s/e1').deps, 'claude://s/e1', 'e1')
    expect(res.ok).toBe(true)
    expect(beats).toEqual(['claude://s/e1'])
  })
})

/**
 * THE ONE LINE THAT MAKES EITHER REAPER REAL.
 *
 * `buildSweepDeps` is the composition root, and until this suite existed nothing
 * guarded it: the `epic-dead-seat-never-settles` werk-verifier proved the gap by
 * replacing the assignment with `void buildSeatReaper` and running
 * `bun test src/broker/` -- 4654 pass, 0 fail. The entire feature could be
 * deleted from the composition root and not one broker test noticed, because
 * every other test in the repo builds `SweepDeps` by hand and supplies its own.
 *
 * That gap is now worse than it was: both lanes ride the SAME seam, so one bad
 * line silently disarms the card-seat reaper and the werk-master reaper together.
 *
 * These tests are behavioural on purpose. `expect(deps.reapers).toBeDefined()`
 * would pass against `NO_REAPING`, which is precisely the mutation that must
 * fail.
 */
describe('buildSweepDeps wires REAL reapers, not the zero value', () => {
  const NOW = Date.parse('2026-08-21T17:00:00.000Z')
  const silent = (agoMs: number): Conversation =>
    ({
      id: 'conv_quiet',
      project: 'claude://s/p',
      status: 'idle',
      lastActivity: NOW - agoMs,
    }) as unknown as Conversation

  /** No socket for anybody -- the shape the incident wore. */
  const store = () =>
    ({
      getAllConversations: () => convs,
      getActiveConversationCount: () => 0,
      hasAnyTranscript: () => true,
      sumConversationCostUsd: () => 0,
      getSentinel: () => undefined,
      getSentinelByAlias: () => undefined,
      addProjectListener: () => {},
      removeProjectListener: () => {},
    }) as unknown as ConversationStore

  const built = () => buildSweepDeps(store(), { now: () => NOW }).reapers

  test('the SEAT reaper reaps, and at SEAT_SILENCE_MS -- not at the zero value', () => {
    expect(built()?.seat(silent(SEAT_SILENCE_MS))).toBeNull()
    expect(built()?.seat(silent(SEAT_SILENCE_MS + 1))).toEqual({ silentForMs: SEAT_SILENCE_MS + 1 })
  })

  test('the WERK-MASTER reaper reaps, and at its OWN, longer grace', () => {
    expect(built()?.werkMaster(silent(WERK_MASTER_SILENCE_MS))).toBeNull()
    expect(built()?.werkMaster(silent(WERK_MASTER_SILENCE_MS + 1))).toEqual({ silentForMs: WERK_MASTER_SILENCE_MS + 1 })
  })

  /**
   * THE ASSERTION THAT CATCHES A SWAP. The two reapers share a structural type,
   * so wiring the seat's grace into the werk-master's field typechecks silently --
   * and costs a second supervisor five minutes early. Twelve minutes of silence
   * is past one grace and inside the other, which is the only window that can
   * tell the two fields apart.
   */
  test('and the two fields carry DIFFERENT graces, in the right order', () => {
    const twelveMinutes = silent(12 * 60_000)
    expect(built()?.seat(twelveMinutes)).not.toBeNull()
    expect(built()?.werkMaster(twelveMinutes)).toBeNull()
  })

  test('both reapers read the FINAL clock, so a `now` override reaches them', () => {
    const reapers = buildSweepDeps(store(), { now: () => NOW + WERK_MASTER_SILENCE_MS * 10 }).reapers
    expect(reapers?.seat(silent(0))).not.toBeNull()
    expect(reapers?.werkMaster(silent(0))).not.toBeNull()
  })

  /** `??=`, not `=`: a caller that wants the old behaviour can still ask for it. */
  test('an explicit NO_REAPING override is honoured', () => {
    const reapers = buildSweepDeps(store(), { now: () => NOW, reapers: NO_REAPING }).reapers
    expect(reapers?.seat(silent(WERK_MASTER_SILENCE_MS * 100))).toBeNull()
    expect(reapers?.werkMaster(silent(WERK_MASTER_SILENCE_MS * 100))).toBeNull()
  })
})

/**
 * THE ONE LINE THE LANDING GATE STANDS ON.
 *
 * `merged` decides whether a run parks over an unmerged branch, and it is a
 * filter over a field nothing else in this engine reads. `dryGens` spent a whole
 * feature stuck at zero for exactly this shape -- a value everything consulted
 * and nothing tested the writing of -- which is why the fold is exported and
 * asserted here rather than left inside the RPC closure.
 */
describe('toGitDirt -- the git fabric, reduced to the sets the engine asks about', () => {
  const branch = (over: Partial<BranchFabric> & { branch: string }): BranchFabric => ({
    aheadOrigin: 0,
    behindOrigin: 0,
    aheadLocal: 0,
    behindLocal: 0,
    integration: 'integrated',
    alerts: [],
    ...over,
  })

  const fold = (branches: BranchFabric[]) => toGitDirt({ branches, scannedAt: 0 })

  test('`merged` is measured against LOCAL main, never origin', () => {
    // In this repo local main is the source of truth and origin is a push-only
    // mirror that routinely sits tens of commits behind. Judging against the
    // remote would call every delivered-but-unpushed card unmerged, in bulk.
    const out = fold([branch({ branch: 'landed', aheadLocal: 0, aheadOrigin: 12 })])
    expect(out.ok && [...out.merged]).toEqual(['landed'])
  })

  test('a branch with commits local main lacks is NOT merged, but IS known', () => {
    // Known-and-not-merged is `ahead`; absent is `gone`. The pair is what tells
    // "still standing" from "cleaned up".
    const out = fold([branch({ branch: 'wip', aheadLocal: 3, integration: 'ff-clean' })])
    expect(out.ok && out.merged.has('wip')).toBe(false)
    expect(out.ok && out.known.has('wip')).toBe(true)
  })

  test('`integration` is deliberately NOT the source -- it is derived from aheadOrigin', () => {
    const out = fold([branch({ branch: 'b', aheadLocal: 2, integration: 'integrated' })])
    expect(out.ok && out.merged.has('b')).toBe(false)
  })

  test('`known` is every branch and `dirty` only the ones with uncommitted work', () => {
    const out = fold([branch({ branch: 'a', dirty: true }), branch({ branch: 'b' })])
    expect(out.ok && [...out.known].sort()).toEqual(['a', 'b'])
    expect(out.ok && [...out.dirty]).toEqual(['a'])
  })
})
