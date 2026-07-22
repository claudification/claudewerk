/**
 * The store is the SOLE seq authority.
 *
 * Regression suite for a bug that ran in production: the broker numbered
 * transcript entries from an in-memory counter (the number it BROADCAST) while
 * SQLite independently numbered the same rows (the number REST reads and
 * backward pagination SERVED). The two only agreed while they happened to share
 * a base, and they stopped sharing one on every broker restart -- the counter
 * starts at 0 -- and on every `isInitial` full-file re-read, which reset it to 0
 * on purpose. On a production store that left 98,486 of 912,472 parent rows
 * (10.8%) carrying a seq that disagreed with the row's own, one conversation
 * numbered 5..37339 by SQLite and 1..544 in the broadcasts of those same rows.
 *
 * Every test here pins one leg of "the seq the dashboard receives is the seq a
 * reader would get back for that uuid".
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation, TranscriptEntry } from '../../shared/protocol'
import { createSqliteDriver } from '../store/sqlite/driver'
import type { StoreDriver } from '../store/types'
import { addTranscriptEntries } from './add-transcript-entries'
import { makeTestContext } from './test-context'

const CONV = 'conv-seq'

const e = (uuid: string, type = 'user'): TranscriptEntry => ({ type, uuid }) as unknown as TranscriptEntry

/** A store on a real (temp) sqlite file, so a "broker restart" can be simulated
 *  by building a SECOND driver over the same directory. */
function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'seq-authority-'))
}

/** Enough of a Conversation for the per-entry handlers + post-loop scans to run
 *  without tripping over absent collections. */
function makeConv(): Conversation {
  return {
    id: CONV,
    events: [],
    subagents: [],
    tasks: [],
    archivedTasks: [],
    bgTasks: [],
    monitors: [],
    teammates: [],
    diagLog: [],
    costTimeline: [],
  } as unknown as Conversation
}

function ctxOver(store: StoreDriver) {
  return makeTestContext({ store, conversations: new Map<string, Conversation>([[CONV, makeConv()]]) })
}

/** The seq a READER would get back for each uuid -- the number that must match
 *  whatever was broadcast. */
function storedSeqs(store: StoreDriver): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of store.transcripts.getLatest(CONV, 100, null)) out[r.uuid] = r.seq
  return out
}

describe('transcript seq authority', () => {
  it('stamps entries with the seq the store assigned, not a counter of its own', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const ctx = ctxOver(store)

    const entries = [e('a'), e('b'), e('c')]
    const accepted = addTranscriptEntries(ctx, CONV, entries, false)

    expect(accepted).toHaveLength(3)
    expect(entries.map(x => x.seq)).toEqual([1, 2, 3])
    expect(storedSeqs(store)).toEqual({ a: 1, b: 2, c: 3 })
  })

  // THE restart case. A second driver over the same file is a new broker
  // process: its in-memory counter is empty, but the DB is not.
  it('continues from the stored max after a broker restart, not from 1', () => {
    const dataDir = freshDataDir()
    const first = createSqliteDriver({ type: 'sqlite', dataDir })
    addTranscriptEntries(ctxOver(first), CONV, [e('a'), e('b'), e('c')], false)

    const restarted = createSqliteDriver({ type: 'sqlite', dataDir })
    const ctx = ctxOver(restarted)
    expect(ctx.transcriptSeqCounters.size).toBe(0) // nothing seeded yet -- the old bug's starting condition

    const afterRestart = [e('d')]
    addTranscriptEntries(ctx, CONV, afterRestart, false)

    expect(afterRestart[0].seq).toBe(4)
    expect(storedSeqs(restarted).d).toBe(4)
    // And the counter sync_check reports as `serverLastSeq` tracks the store,
    // so a dashboard is never told it is up to date when it is not.
    expect(ctx.transcriptSeqCounters.get(CONV)).toBe(4)
  })

  it('never renumbers on an isInitial full re-read of already-stored entries', () => {
    const dataDir = freshDataDir()
    const store = createSqliteDriver({ type: 'sqlite', dataDir })
    addTranscriptEntries(ctxOver(store), CONV, [e('a'), e('b'), e('c')], false)

    // The agent host reconnects and resends the whole file (resendTranscriptFromFile).
    const restarted = createSqliteDriver({ type: 'sqlite', dataDir })
    const resent = [e('a'), e('b'), e('c'), e('d')]
    const broadcast = addTranscriptEntries(ctxOver(restarted), CONV, resent, true)

    // A snapshot REPLACE must carry every entry, including the ones already
    // stored -- dropping them would blank the dashboard, which treats an
    // isInitial payload as "replace what you have with this".
    expect(broadcast.map(x => x.uuid)).toEqual(['a', 'b', 'c', 'd'])
    // ...each carrying its ORIGINAL seq, not a fresh 1..4.
    expect(resent.map(x => x.seq)).toEqual([1, 2, 3, 4])
    expect(storedSeqs(restarted)).toEqual({ a: 1, b: 2, c: 3, d: 4 })
  })

  it('drops already-stored entries from a non-initial append so replays do not duplicate', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const ctx = ctxOver(store)
    addTranscriptEntries(ctx, CONV, [e('a'), e('b')], false)

    // The agent host replays its buffer on reconnect (replayLaunchEvents).
    const replayed = [e('a'), e('b')]
    const accepted = addTranscriptEntries(ctx, CONV, replayed, false)

    expect(accepted).toEqual([])
    // Still stamped, so a caller that broadcasts anyway sends the TRUE seq --
    // which the dashboard's `seq > lastApplied` filter then correctly drops.
    expect(replayed.map(x => x.seq)).toEqual([1, 2])
    expect(ctx.transcriptCache.get(CONV)?.map(x => x.uuid)).toEqual(['a', 'b'])
  })

  it('passes through only the genuinely new entries of a mixed batch', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const ctx = ctxOver(store)
    addTranscriptEntries(ctx, CONV, [e('a'), e('b')], false)

    const accepted = addTranscriptEntries(ctx, CONV, [e('a'), e('b'), e('c')], false)
    expect(accepted.map(x => x.uuid)).toEqual(['c'])
    expect(accepted[0].seq).toBe(3)
    expect(ctx.transcriptCache.get(CONV)?.map(x => x.uuid)).toEqual(['a', 'b', 'c'])
  })

  // The consequence that made this visible: scrollback pages with `?before=<seq>`
  // against stored seqs, so a broadcast seq from a different numbering paged
  // into the wrong part of history.
  it('every broadcast seq matches the seq a reader gets for that uuid', () => {
    const dataDir = freshDataDir()
    let store = createSqliteDriver({ type: 'sqlite', dataDir })
    const broadcast: TranscriptEntry[] = []

    // Three broker lifetimes, with a full re-read in the middle -- the exact
    // sequence that used to desync the two numberings.
    broadcast.push(...addTranscriptEntries(ctxOver(store), CONV, [e('a'), e('b')], false))
    store = createSqliteDriver({ type: 'sqlite', dataDir })
    addTranscriptEntries(ctxOver(store), CONV, [e('a'), e('b'), e('c')], true)
    broadcast.push(e('c') as TranscriptEntry)
    store = createSqliteDriver({ type: 'sqlite', dataDir })
    broadcast.push(...addTranscriptEntries(ctxOver(store), CONV, [e('d')], false))

    const stored = storedSeqs(store)
    for (const entry of broadcast) {
      if (entry.seq === undefined) continue
      expect(stored[entry.uuid as string]).toBe(entry.seq)
    }
    // Contiguous: an ignored duplicate must not burn a number, or the REST
    // delta gap check misfires and the dashboard full-replaces.
    expect(Object.values(stored).sort((x, y) => x - y)).toEqual([1, 2, 3, 4])
  })

  // The uuid-LESS path. Launch / attachment / queued-user / system entries reach
  // the store with no uuid of their own. The store dedups on
  // (conversation_id, uuid), so the SYNTHESIZED uuid must be identical across
  // replays -- or every reconnect mints a fresh row with a fresh high seq while
  // the entry keeps its ORIGINAL (old) timestamp. That is the production bug the
  // seq-authority fix could not reach: a replayed first user input got a brand
  // new high seq and sorted to the BOTTOM of the transcript, plus 10%+ holes and
  // duplicate launch cards. Fresh objects each replay, exactly how the agent
  // host re-sends its buffer (it never saw the broker's synthesized id).
  it('dedups uuid-less entries across a replay instead of minting fresh seqs', () => {
    const noUuid = (type: string, timestamp: string, extra: Record<string, unknown> = {}): TranscriptEntry =>
      ({ type, timestamp, ...extra }) as unknown as TranscriptEntry
    const batch = () => [
      noUuid('launch', '2026-07-22T07:00:00.000Z', { launchId: 'L1', step: 'spawn' }),
      noUuid('attachment', '2026-07-22T07:00:01.000Z', { name: 'a.png' }),
    ]

    const dataDir = freshDataDir()
    const first = createSqliteDriver({ type: 'sqlite', dataDir })
    const original = batch()
    addTranscriptEntries(ctxOver(first), CONV, original, false)
    const originalUuids = original.map(x => x.uuid)
    expect(originalUuids.every(u => typeof u === 'string' && u.length > 0)).toBe(true)
    expect(original.map(x => x.seq)).toEqual([1, 2])

    // New broker process; the host replays the same logical entries as FRESH
    // objects that carry no uuid.
    const restarted = createSqliteDriver({ type: 'sqlite', dataDir })
    const replay = batch()
    const accepted = addTranscriptEntries(ctxOver(restarted), CONV, replay, false)

    // Same content -> same synthesized uuid -> the store recognizes the replay.
    expect(replay.map(x => x.uuid)).toEqual(originalUuids)
    // Nothing new: no fresh seqs, no duplicate rows, seq keeps tracking time.
    expect(accepted).toEqual([])
    expect(replay.map(x => x.seq)).toEqual([1, 2])
    expect(Object.keys(storedSeqs(restarted))).toHaveLength(2)
  })

  it('falls back to the in-memory counter when there is no store', () => {
    const ctx = makeTestContext()
    const entries = [e('a'), e('b')]
    const accepted = addTranscriptEntries(ctx, CONV, entries, false)
    expect(accepted.map(x => x.uuid)).toEqual(['a', 'b'])
    expect(entries.map(x => x.seq)).toEqual([1, 2])
  })
})
