import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  forgetArmedEpic,
  forgetDeletedEpic,
  initArmedEpics,
  isArmed,
  isDeletedEpic,
  listArmedEpics,
  listDeletedEpics,
  noteArmedEpic,
  noteDeletedEpic,
  resetArmedEpics,
} from './epic-registry'
import { epicsToWatch } from './epic-sweep'
import { createSqliteKVStore } from './store/sqlite/kv'
import type { KVStore } from './store/types'

const P = 'claude://studio/proj'
const Q = 'claude://studio/other'

afterEach(() => resetArmedEpics())

describe('the armed-epic registry', () => {
  test('nothing is armed to start with', () => {
    expect(listArmedEpics()).toEqual([])
  })

  test('arming makes an epic visible to the sweep', () => {
    noteArmedEpic(P, 'e1')
    expect(isArmed(P, 'e1')).toBe(true)
    expect(listArmedEpics()).toEqual([{ project: P, epicId: 'e1' }])
  })

  test('arming twice is idempotent -- re-starting a run must not double it', () => {
    noteArmedEpic(P, 'e1')
    noteArmedEpic(P, 'e1')
    expect(listArmedEpics()).toHaveLength(1)
  })

  test('the same epic id in two projects is two entries', () => {
    noteArmedEpic(P, 'e1')
    noteArmedEpic(Q, 'e1')
    expect(listArmedEpics()).toHaveLength(2)
  })

  test('forgetting one project does not forget the other', () => {
    noteArmedEpic(P, 'e1')
    noteArmedEpic(Q, 'e1')
    forgetArmedEpic(P, 'e1')
    expect(isArmed(P, 'e1')).toBe(false)
    expect(isArmed(Q, 'e1')).toBe(true)
  })

  test('forgetting something never armed is a no-op, not a throw', () => {
    expect(() => forgetArmedEpic(P, 'ghost')).not.toThrow()
  })
})

/** The registry is keyed by PROJECT IDENTITY, not by the exact string the caller
 *  happened to spell. `start` is reached from an MCP call typing
 *  `claude:///path`, while the store and every canonical writer say
 *  `claude://default/path` -- keying on the raw string made an armed run
 *  invisible to a differently-spelled `isArmed`. */
describe('the armed-epic registry is spelling-blind', () => {
  const TYPED = 'claude:///Users/jonas/projects/remote-claude'
  const SCARRED = 'claude:////Users/jonas/projects/remote-claude/'
  const CANONICAL = 'claude://default/Users/jonas/projects/remote-claude'

  test('isArmed matches an equivalent but differently-normalized URI', () => {
    noteArmedEpic(TYPED, 'e1')
    expect(isArmed(CANONICAL, 'e1')).toBe(true)
    expect(isArmed(SCARRED, 'e1')).toBe(true)
  })

  test('arming twice under two spellings is ONE entry', () => {
    noteArmedEpic(TYPED, 'e1')
    noteArmedEpic(CANONICAL, 'e1')
    expect(listArmedEpics()).toHaveLength(1)
  })

  test('forgetting under a different spelling still forgets', () => {
    noteArmedEpic(TYPED, 'e1')
    forgetArmedEpic(CANONICAL, 'e1')
    expect(isArmed(TYPED, 'e1')).toBe(false)
  })

  test('the stored project stays the RAW URI the caller armed with', () => {
    noteArmedEpic(TYPED, 'e1')
    expect(listArmedEpics()).toEqual([{ project: TYPED, epicId: 'e1' }])
  })

  test('two genuinely different projects are still two entries', () => {
    noteArmedEpic(TYPED, 'e1')
    noteArmedEpic('claude:///Users/jonas/projects/elsewhere', 'e1')
    expect(listArmedEpics()).toHaveLength(2)
  })
})

/**
 * A BROKER RESTART MUST NOT STRAND A RUN.
 *
 * The set used to be a plain in-memory `Map`, and the header comment claimed
 * only "the gap between armed and first dispatch" was lossy. It was not: the
 * sweep unions this set with epics found through LIVE CONVERSATIONS, so a
 * restarted run stayed visible exactly as long as a seat was open and vanished
 * the moment the last one exited -- which for a healthy run happens between
 * every pair of beats. `epic-the-wall` died that way on 2026-08-19.
 *
 * A REAL SQLITE KV, not a Map-backed fake, and that is deliberate. The obvious
 * implementation persists the NUL-joined map key, and a bound key containing
 * `\0` silently fails to round-trip through `bun:sqlite` -- arming would look
 * fine and rehydrate nothing. Only a real driver catches that.
 */
describe('the armed set survives a broker restart', () => {
  const TYPED = 'claude:///Users/jonas/projects/remote-claude'
  const CANONICAL = 'claude://default/Users/jonas/projects/remote-claude'

  /** The broker's own kv table, exactly as `schema.ts` declares it. `strict:
   *  true` is not decoration -- `createSqliteKVStore` binds bare `key`/`value`
   *  keys, which a non-strict open binds as SILENT NULL. */
  function freshKv(): KVStore {
    const db = new Database(':memory:', { strict: true })
    db.run('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    return createSqliteKVStore(db)
  }

  /** Everything a restart does to this module: the process dies with its `Map`,
   *  comes back, and is handed the SAME store. */
  function restart(kv: KVStore): void {
    resetArmedEpics()
    expect(listArmedEpics()).toEqual([])
    initArmedEpics(kv)
  }

  test('an epic armed before the restart is still armed after it', () => {
    const kv = freshKv()
    initArmedEpics(kv)
    noteArmedEpic(P, 'e1')

    restart(kv)

    expect(isArmed(P, 'e1')).toBe(true)
    expect(listArmedEpics()).toEqual([{ project: P, epicId: 'e1' }])
  })

  test('and the sweep therefore still finds it with ZERO conversations', () => {
    // The failure in full: no live conversation means the conversation half of
    // `epicsToWatch` is empty, so the armed half is the only thing keeping the
    // run in the engine's sight.
    const kv = freshKv()
    initArmedEpics(kv)
    noteArmedEpic(P, 'e1')

    restart(kv)

    expect(epicsToWatch([], () => false).map(g => g.epicId)).toEqual(['e1'])
  })

  test('a forgotten epic stays forgotten -- park/pause/abort are durable too', () => {
    const kv = freshKv()
    initArmedEpics(kv)
    noteArmedEpic(P, 'e1')
    noteArmedEpic(Q, 'e2')
    forgetArmedEpic(P, 'e1')

    restart(kv)

    expect(isArmed(P, 'e1')).toBe(false)
    expect(listArmedEpics()).toEqual([{ project: Q, epicId: 'e2' }])
  })

  test('the persisted entry is matched by IDENTITY, not by the spelling that armed it', () => {
    // The whole point of `runner-list-project-uri-unnormalized` landing first:
    // persisting the raw string would have persisted that bug.
    const kv = freshKv()
    initArmedEpics(kv)
    noteArmedEpic(TYPED, 'e1')

    restart(kv)

    expect(isArmed(CANONICAL, 'e1')).toBe(true)
    expect(isArmed('claude:////Users/jonas/projects/remote-claude/', 'e1')).toBe(true)
    // ...and the RAW uri the caller armed with is what comes back out, because
    // that is what the sweep hands onward to the sentinel.
    expect(listArmedEpics()).toEqual([{ project: TYPED, epicId: 'e1' }])
  })

  test('re-arming after a restart does not double the entry', () => {
    const kv = freshKv()
    initArmedEpics(kv)
    noteArmedEpic(TYPED, 'e1')

    restart(kv)
    noteArmedEpic(CANONICAL, 'e1')

    expect(listArmedEpics()).toHaveLength(1)
  })

  test('hydration REPLACES whatever was in memory rather than merging into it', () => {
    // A second `init` is a restart, not a top-up. Merging would resurrect an
    // epic that was forgotten while the store was detached.
    const kv = freshKv()
    initArmedEpics(kv)
    noteArmedEpic(P, 'persisted')
    resetArmedEpics()
    noteArmedEpic(Q, 'memory-only')

    initArmedEpics(kv)

    expect(listArmedEpics()).toEqual([{ project: P, epicId: 'persisted' }])
  })

  test('a store holding garbage boots empty instead of throwing', () => {
    // A broker that cannot boot is worse than one that forgets a run.
    const kv = freshKv()
    kv.set('epic:armed', [{ project: 'claude://s/p' }, null, 'nonsense', { epicId: 'e1' }])
    expect(() => initArmedEpics(kv)).not.toThrow()
    expect(listArmedEpics()).toEqual([])
  })

  test('with no store wired at all, arming still works -- memory-only, never a throw', () => {
    // A broker running without a store driver must still be able to arm a run.
    resetArmedEpics()
    expect(() => noteArmedEpic(P, 'e1')).not.toThrow()
    expect(isArmed(P, 'e1')).toBe(true)
  })

  /**
   * A DELETED RUN MUST NOT COME BACK ON THE NEXT BOOT -- the same durability
   * question as the armed set, asked the other way round.
   *
   * The broker does not find runs on disk, so moving the artifact away is not
   * enough on its own: the conversation registry keeps a seat long after it
   * ends, which would rebuild the group forever. An in-memory-only tombstone
   * would work exactly until the next restart and then resurrect every deleted
   * run at once.
   */
  test('a deleted run stays deleted across a restart', () => {
    const kv = freshKv()
    initArmedEpics(kv)
    noteDeletedEpic(P, 'e1')

    restart(kv)

    expect(isDeletedEpic(P, 'e1')).toBe(true)
    expect(listDeletedEpics()).toEqual([{ project: P, epicId: 'e1' }])
  })

  test('and the sweep therefore does NOT find it, even with a seat still in the registry', () => {
    const kv = freshKv()
    initArmedEpics(kv)
    noteDeletedEpic(P, 'e1')
    restart(kv)

    const seats = [
      { id: 'c1', project: P, status: 'ended', launchConfig: { epic: { epicId: 'e1', role: 'werk-worker', gen: 1 } } },
    ]

    expect(epicsToWatch(seats as never, () => false).map(g => g.epicId)).toEqual([])
  })

  test('the tombstone is spelling-blind, exactly as the armed set is', () => {
    noteDeletedEpic('claude:///Users/jonas/projects/remote-claude', 'e1')
    expect(isDeletedEpic('claude://default/Users/jonas/projects/remote-claude', 'e1')).toBe(true)
  })

  /** ARMING UN-DELETES. A `start` writes a fresh run.md, so leaving the
   *  tombstone would keep a genuinely running run off every surface. */
  test('forgetting the tombstone brings the epic back into the sweep', () => {
    const kv = freshKv()
    initArmedEpics(kv)
    noteDeletedEpic(P, 'e1')
    noteArmedEpic(P, 'e1')
    expect(epicsToWatch([], () => false)).toEqual([])

    forgetDeletedEpic(P, 'e1')

    expect(epicsToWatch([], () => false).map(g => g.epicId)).toEqual(['e1'])
    // ...and it stays back after a restart, rather than being re-buried.
    restart(kv)
    expect(isDeletedEpic(P, 'e1')).toBe(false)
  })

  test('a store holding tombstone garbage boots empty instead of throwing', () => {
    const kv = freshKv()
    kv.set('epic:deleted', [{ project: 'claude://s/p' }, null, 'nonsense'])
    expect(() => initArmedEpics(kv)).not.toThrow()
    expect(listDeletedEpics()).toEqual([])
  })
})
