/**
 * THE ONE ARM PATH.
 *
 * Two callers arm epic runs -- the RUN button (via `POST /api/epic`) and a
 * schedule whose action is `epic-start` -- and what these pin down is that the
 * bookkeeping is not the route's. An arm that forwarded the sentinel op alone
 * would write a `run.md` nothing ever beats: the sweep finds a conversation-less
 * run only through the armed set, and a tombstoned epic renders on no surface at
 * all.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { EpicRunSnapshot } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import { armEpicRun, capCapabilityRefusal, epicsScannerRefusal, trackEpicOp } from './epic-arm'
import { isArmed, isDeletedEpic, noteDeletedEpic, resetArmedEpics } from './epic-registry'
import { initProjectSettings, setProjectSettings } from './project-settings'
import type { KVStore } from './store/types'

const PROJECT = 'claude://default/Users/jonas/projects/demo'

function memoryKv(): KVStore {
  const map = new Map<string, unknown>()
  return {
    get: <T>(key: string) => (map.get(key) as T) ?? null,
    set: (key, value) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
    keys: () => [...map.keys()],
  }
}

/** No sentinel connected, which is enough for the gate tests: every arm that
 *  gets PAST the opt-in fails with "no sentinel", and that failure is the proof
 *  it got past. */
const store = {
  getSentinel: () => undefined,
  getSentinelByAlias: () => undefined,
  addProjectListener: () => {},
  removeProjectListener: () => {},
} as unknown as ConversationStore

beforeEach(() => {
  resetArmedEpics()
  initProjectSettings(memoryKv())
  setProjectSettings(PROJECT, { scanners: undefined })
})
afterEach(() => resetArmedEpics())

describe('the "epics" opt-in refuses at the ARM', () => {
  test('an unticked project gets a refusal that names the box', () => {
    const refusal = epicsScannerRefusal(PROJECT)
    expect(refusal).toContain('would never be swept')
    expect(refusal).toContain('Project Settings > Scanners')
  })

  test('a ticked project has nothing to refuse', () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    expect(epicsScannerRefusal(PROJECT)).toBeNull()
  })

  test('armEpicRun refuses BEFORE it spends a sentinel round trip', async () => {
    const result = await armEpicRun(store, { project: PROJECT, epicId: 'e1' })
    expect(result).toMatchObject({ ok: false, status: 400 })
    // And nothing was registered on the strength of a refusal.
    expect(isArmed(PROJECT, 'e1')).toBe(false)
  })

  test('a ticked project gets past the gate and out to the sentinel', async () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    const result = await armEpicRun(store, { project: PROJECT, epicId: 'e1' })
    expect(result).toMatchObject({ ok: false, status: 502 })
    expect((result as { error: string }).error).toContain('no sentinel')
  })

  test('a sentinel that refused the write arms NOTHING -- the sweep must not beat a run that does not exist', async () => {
    setProjectSettings(PROJECT, { scanners: { epics: true } })
    await armEpicRun(store, { project: PROJECT, epicId: 'e1' })
    expect(isArmed(PROJECT, 'e1')).toBe(false)
  })
})

/**
 * ARMING UN-DELETES.
 *
 * A `start` writes a fresh `run.md`, so the epic has a real run again. Leaving
 * its tombstone in place would keep that new run off the wall, the badge and
 * `list` while it was genuinely running -- the invisibility the whole tail
 * section exists to prevent, arriving through a verb that is supposed to be
 * recoverable.
 */
describe('the registry bookkeeping a successful op does', () => {
  test('start arms the run AND clears any tombstone on it', () => {
    noteDeletedEpic(PROJECT, 'e1')

    trackEpicOp({ project: PROJECT, op: 'start', epicId: 'e1' })

    expect(isArmed(PROJECT, 'e1')).toBe(true)
    expect(isDeletedEpic(PROJECT, 'e1')).toBe(false)
  })

  test('pause and abort un-arm without touching the tombstone set', () => {
    noteDeletedEpic(PROJECT, 'other')
    trackEpicOp({ project: PROJECT, op: 'start', epicId: 'e1' })

    trackEpicOp({ project: PROJECT, op: 'pause', epicId: 'e1' })

    expect(isArmed(PROJECT, 'e1')).toBe(false)
    expect(isDeletedEpic(PROJECT, 'other')).toBe(true)
  })

  test('a read leaves both sets exactly as they were', () => {
    trackEpicOp({ project: PROJECT, op: 'start', epicId: 'e1' })
    trackEpicOp({ project: PROJECT, op: 'get', epicId: 'e1' })
    expect(isArmed(PROJECT, 'e1')).toBe(true)
  })
})

/**
 * A RUN THAT CANNOT BE CAPPED DOES NOT START.
 *
 * The sentinel owns `run.md` and ships as a FROZEN BUNDLE that deploys
 * separately from the broker, so a bundle built before the ceilings landed
 * answers `start` with `maxUsd`, `maxWallClockMinutes` and `spentUsd` absent --
 * and every arithmetic test downstream (`run.maxUsd > 0`) then reads absent as
 * "deliberately uncapped". The run bills without a budget and nothing anywhere
 * says so. The documented remedy was a human remembering to run
 * `grep -c maxUsd packages/sentinel/bin/sentinel`, which is not a mechanism.
 *
 * THE REPLY IS THE PROBE: `start` sends the ceilings and the sentinel echoes the
 * run back, so an echo without them is proof, on the one call that matters, with
 * no version handshake to keep in step.
 */
const FULL_RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: PROJECT,
  cadence: ['now'],
  status: 'armed',
  gen: 0,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

describe('capCapabilityRefusal -- the wording is most of the value', () => {
  test('a reply that carries the ceilings has nothing to refuse', () => {
    expect(capCapabilityRefusal(FULL_RUN)).toBeNull()
  })

  test('a DISARMED run still arms -- a typed 0 is an answer, absence is not', () => {
    expect(capCapabilityRefusal({ ...FULL_RUN, maxUsd: 0, maxWallClockMinutes: 0 })).toBeNull()
  })

  test('a bundle that predates the ceilings is refused, and told which command fixes it', () => {
    const stale = { ...FULL_RUN } as Partial<EpicRunSnapshot>
    stale.maxUsd = undefined
    stale.maxWallClockMinutes = undefined
    stale.spentUsd = undefined

    const refusal = capCapabilityRefusal(stale as EpicRunSnapshot)
    expect(refusal).toContain('maxUsd')
    expect(refusal).toContain('build:packages')
    expect(refusal).toContain('never an absence')
  })

  test('a successful start that answered with no run at all is refused too', () => {
    expect(capCapabilityRefusal(null)).toContain('carried no run at all')
  })
})

/**
 * A sentinel on the other end of the socket, answering `epic_op` with whatever
 * the test says. The point is the ARM's behaviour on a reply, so the transport is
 * real (`sendSentinelOp` registers the listener, `send` answers it) and only the
 * bundle behind it is fake.
 */
function fakeSentinel(runFor: (op: string) => EpicRunSnapshot | null) {
  const listeners = new Map<string, (result: unknown) => void>()
  const sent: string[] = []
  const sentinel = {
    send: (raw: string) => {
      const msg = JSON.parse(raw) as { requestId: string; op: string }
      sent.push(msg.op)
      queueMicrotask(() =>
        listeners.get(msg.requestId)?.({
          type: 'epic_result',
          requestId: msg.requestId,
          op: msg.op,
          ok: true,
          run: runFor(msg.op),
        }),
      )
    },
  }
  const store = {
    getSentinel: () => sentinel,
    getSentinelByAlias: () => undefined,
    addProjectListener: (id: string, cb: (result: unknown) => void) => void listeners.set(id, cb),
    removeProjectListener: (id: string) => void listeners.delete(id),
    // A successful arm publishes the activity badge without waiting for the next
    // 45s tick, and that fold walks the registry. Empty is the honest answer for
    // a run with no conversations yet, which is every run at the moment it arms.
    getAllConversations: () => [],
    getSentinels: () => [],
    broadcastConversationScoped: () => {},
  } as unknown as ConversationStore
  return { store, sent }
}

describe('arming against a sentinel that cannot carry the ceilings', () => {
  beforeEach(() => setProjectSettings(PROJECT, { scanners: { epics: true } }))

  const capBlind = (): EpicRunSnapshot => {
    const run = { ...FULL_RUN } as Partial<EpicRunSnapshot>
    run.maxUsd = undefined
    run.maxWallClockMinutes = undefined
    run.spentUsd = undefined
    return run as EpicRunSnapshot
  }

  test('the arm is REFUSED rather than reported as a success', async () => {
    const { store: blind } = fakeSentinel(() => capBlind())
    const result = await armEpicRun(blind, { project: PROJECT, epicId: 'e1' })
    expect(result).toMatchObject({ ok: false, status: 502 })
    expect((result as { error: string }).error).toContain('REFUSING TO ARM')
  })

  test('the sweep never learns about it -- an unregistered run is inert', async () => {
    const { store: blind } = fakeSentinel(() => capBlind())
    await armEpicRun(blind, { project: PROJECT, epicId: 'e1' })
    expect(isArmed(PROJECT, 'e1')).toBe(false)
  })

  /**
   * The refusal is decided from the REPLY, so the artifact already exists on
   * disk saying `armed`. Walking away would leave a `run.md` no arm ever
   * registered -- the exact "sits armed forever, invisible to the sweep" failure
   * this module exists to prevent, arriving through the safety check.
   */
  test('the run the sentinel already wrote is put back -- paused, and recorded on the baton', async () => {
    const { store: blind, sent } = fakeSentinel(() => capBlind())
    await armEpicRun(blind, { project: PROJECT, epicId: 'e1' })
    expect(sent).toEqual(['start', 'pause', 'log_append'])
  })

  test('a healthy sentinel arms exactly as before', async () => {
    const { store: healthy, sent } = fakeSentinel(() => FULL_RUN)
    const result = await armEpicRun(healthy, { project: PROJECT, epicId: 'e1' })
    expect(result.ok).toBe(true)
    expect(isArmed(PROJECT, 'e1')).toBe(true)
    // Whatever else the activity publish goes on to read, nothing put the run back.
    expect(sent[0]).toBe('start')
    expect(sent).not.toContain('pause')
  })
})
