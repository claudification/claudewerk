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
import type { ConversationStore } from './conversation-store'
import { armEpicRun, epicsScannerRefusal, trackEpicOp } from './epic-arm'
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
