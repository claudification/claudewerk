/**
 * `isInitial` is a RECONCILIATION, not a snapshot swap.
 *
 * Regression suite for a bug that ran in production: `appendToCache` REPLACED
 * the broker's in-memory transcript cache with whatever batch carried
 * `isInitial`. That is only sound if the batch is the full record -- and in
 * HEADLESS it never is.
 *
 * The JSONL file and the stream-json stdout pipe are disjoint in both
 * directions (see transcript-entry-filter.ts). A headless resend is read from
 * the FILE and then further narrowed by `selectForwardableEntries`, so it
 * carries no `system/status`, no `notification`, no `away_summary`, no
 * `background_tasks_changed`, no `queue-operation` -- those live only on
 * stdout. Letting such a batch overwrite the cache deleted every one of them,
 * and `handlers/transcript.ts` serves the CACHE in preference to the store, so
 * the next conversation open or switch rendered a gutted transcript.
 *
 * The store is append-only (`INSERT OR IGNORE`), so it always holds the union
 * of both paths. That -- never the incoming batch -- is what the cache must be
 * rebuilt from.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation, TranscriptEntry } from '../../shared/protocol'
import { createSqliteDriver } from '../store/sqlite/driver'
import type { StoreDriver } from '../store/types'
import { addTranscriptEntries } from './add-transcript-entries'
import type { ConversationStoreContext } from './event-context'
import { makeTestContext } from './test-context'

const CONV = 'conv-initial-cache'

/** Entries carry a real timestamp: order is the other half of this contract. */
function entry(uuid: string, type: string, tsSeconds: number, subtype?: string): TranscriptEntry {
  return {
    type,
    uuid,
    ...(subtype ? { subtype } : {}),
    timestamp: new Date(Date.UTC(2026, 6, 22, 13, 0, tsSeconds)).toISOString(),
  } as unknown as TranscriptEntry
}

function freshStore(): StoreDriver {
  return createSqliteDriver({ type: 'sqlite', dataDir: mkdtempSync(join(tmpdir(), 'initial-cache-')) })
}

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

function ctxOver(store: StoreDriver): ConversationStoreContext {
  return makeTestContext({ store, conversations: new Map<string, Conversation>([[CONV, makeConv()]]) })
}

const uuidsInCache = (ctx: ConversationStoreContext): string[] =>
  (ctx.transcriptCache.get(CONV) || []).map(e => e.uuid as string)

describe('isInitial reconciles the cache instead of replacing it', () => {
  // THE production case. Live stdout fills the cache, then a headless file
  // resend arrives carrying only the file's share of the record.
  it('keeps stdout-only entries when a partial headless resend claims isInitial', () => {
    const store = freshStore()
    const ctx = ctxOver(store)

    // Live phase: stdout owns user/assistant, and is the SOLE source of the
    // status/notification/queue-operation rows -- they are not in the JSONL.
    addTranscriptEntries(
      ctx,
      CONV,
      [
        entry('u1', 'user', 1),
        entry('sys-status', 'system', 2, 'status'),
        entry('a1', 'assistant', 3),
        entry('queue-1', 'queue-operation', 4),
        entry('sys-notify', 'system', 5, 'notification'),
        entry('sys-away', 'system', 6, 'away_summary'),
      ],
      false,
    )
    expect(uuidsInCache(ctx)).toHaveLength(6)

    // Resend phase: read from the JSONL, narrowed by selectForwardableEntries.
    // Only user/assistant survive that filter -- plus one file-only row the
    // live path could never deliver.
    addTranscriptEntries(
      ctx,
      CONV,
      [entry('u1', 'user', 1), entry('a1', 'assistant', 3), entry('hook-1', 'system', 7, 'stop_hook_summary')],
      true,
    )

    // The stdout-only rows must still be there. Before the fix the cache held
    // exactly the 3 resent entries and the other 4 were gone.
    expect(uuidsInCache(ctx).sort()).toEqual(['a1', 'hook-1', 'queue-1', 'sys-away', 'sys-notify', 'sys-status', 'u1'])
  })

  // The cache is rebuilt from the STORE, so it must not double-count a resent
  // entry either.
  it('does not duplicate entries the resend repeats', () => {
    const store = freshStore()
    const ctx = ctxOver(store)

    addTranscriptEntries(ctx, CONV, [entry('u1', 'user', 1), entry('a1', 'assistant', 2)], false)
    addTranscriptEntries(ctx, CONV, [entry('u1', 'user', 1), entry('a1', 'assistant', 2)], true)

    expect(uuidsInCache(ctx)).toEqual(['u1', 'a1'])
  })

  // A gap-fill is the whole reason the resend path exists: an entry stdout
  // dropped during a socket blip reaches the broker only from the file, minutes
  // late. It must land in CHRONOLOGICAL position, not at the tail, because seq
  // is an arrival counter and the dashboard renders in cache/read order.
  it('places a late gap-fill by timestamp, not at the tail', () => {
    const store = freshStore()
    const ctx = ctxOver(store)

    addTranscriptEntries(
      ctx,
      CONV,
      [entry('early', 'assistant', 10), entry('later', 'assistant', 30), entry('latest', 'assistant', 40)],
      false,
    )

    // Recovered from the file long after the fact: its timestamp sits BETWEEN
    // 'early' and 'later', but it is ingested last so it gets MAX(seq)+1.
    addTranscriptEntries(ctx, CONV, [entry('gapfill', 'assistant', 20)], true)

    expect(uuidsInCache(ctx)).toEqual(['early', 'gapfill', 'later', 'latest'])
  })
})
