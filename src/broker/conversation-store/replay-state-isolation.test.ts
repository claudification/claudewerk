/**
 * A REPLAY MUST NOT MUTATE DERIVED STATE.
 *
 * The transcript pipe carries two different things and used to treat them as
 * one. Content is an append-only LOG: dated, uuid-keyed, idempotent, and worth
 * replaying because the wire is lossy. Conversation state (title, summary,
 * agentName, prLinks, stats) is a SNAPSHOT with several writers, and replaying
 * it is a time-travel bug generator.
 *
 * The old shape made that unavoidable: every `isInitial` batch WIPED the derived
 * fields and re-folded them from whatever the replay happened to contain, so
 * - a resend of a long conversation re-summed stats from the tail-500 the
 *   watcher ships, throwing away the rest, and
 * - CC's stale metadata lines re-applied on every reconnect (2026-07-28: 3242
 *   `[meta]` writes across ~40 conversations in one boot).
 *
 * The fold now runs over the entries the STORE had not already seen, which is a
 * number the ingest already computes. Replay contributes nothing because there
 * is nothing new in it -- no reset needed, no double count possible.
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

const CONV = 'conv-replay'

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'replay-isolation-'))
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

function ctxOver(store: StoreDriver, conv: Conversation) {
  return makeTestContext({ store, conversations: new Map<string, Conversation>([[CONV, conv]]) })
}

/** An assistant turn worth 100 input / 10 output tokens. */
function turn(uuid: string): TranscriptEntry {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-07-29T07:00:00.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  } as unknown as TranscriptEntry
}

const summaryEntry = (uuid: string, summary: string): TranscriptEntry =>
  ({ type: 'summary', uuid, summary }) as unknown as TranscriptEntry

describe('replay does not double-count stats', () => {
  it('re-sending the same entries leaves the totals where they were', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const conv = makeConv()
    const ctx = ctxOver(store, conv)

    addTranscriptEntries(ctx, CONV, [turn('t1'), turn('t2')], false)
    const afterLive = { ...conv.stats }
    expect(afterLive.totalOutputTokens).toBe(20)

    // The same two entries arrive again as a replay batch.
    addTranscriptEntries(ctx, CONV, [turn('t1'), turn('t2')], true)
    expect(conv.stats).toEqual(afterLive)
  })

  it('a TRUNCATED replay does not shrink the totals to what it happens to carry', () => {
    // The regression this exists for: the watcher ships `metadata + tail 500` on
    // an initial read of a long file, and the old reset re-summed ONLY that,
    // so a reconnect quietly rewrote a long conversation's lifetime totals.
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const conv = makeConv()
    const ctx = ctxOver(store, conv)

    const all = Array.from({ length: 6 }, (_, i) => turn(`t${i}`))
    addTranscriptEntries(ctx, CONV, all, false)
    expect(conv.stats.totalOutputTokens).toBe(60)

    // Reconnect: only the tail survives truncation.
    addTranscriptEntries(ctx, CONV, all.slice(-2), true)
    expect(conv.stats.totalOutputTokens).toBe(60)
  })

  it('still counts genuinely new entries that arrive in a replay batch', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const conv = makeConv()
    const ctx = ctxOver(store, conv)

    addTranscriptEntries(ctx, CONV, [turn('t1')], false)
    // A gap-fill: the replay carries one the broker never saw.
    addTranscriptEntries(ctx, CONV, [turn('t1'), turn('t2')], true)
    expect(conv.stats.totalOutputTokens).toBe(20)
  })
})

describe('replay does not revert metadata', () => {
  it('a replayed summary does not overwrite a newer one', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const conv = makeConv()
    const ctx = ctxOver(store, conv)

    addTranscriptEntries(ctx, CONV, [summaryEntry('s1', 'first summary')], false)
    addTranscriptEntries(ctx, CONV, [summaryEntry('s2', 'newer summary')], false)
    expect(conv.summary).toBe('newer summary')

    // Reconnect replays the whole file, oldest first.
    addTranscriptEntries(ctx, CONV, [summaryEntry('s1', 'first summary'), summaryEntry('s2', 'newer summary')], true)
    expect(conv.summary).toBe('newer summary')
  })

  it('a genuinely new summary in a replay batch still applies', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const conv = makeConv()
    const ctx = ctxOver(store, conv)

    addTranscriptEntries(ctx, CONV, [summaryEntry('s1', 'first summary')], false)
    addTranscriptEntries(ctx, CONV, [summaryEntry('s1', 'first summary'), summaryEntry('s2', 'later summary')], true)
    expect(conv.summary).toBe('later summary')
  })

  it('a replayed custom-title cannot revert a title set after it', () => {
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const conv = makeConv()
    const ctx = ctxOver(store, conv)

    const launchTitle = { type: 'custom-title', uuid: 'ct1', customTitle: 'launch-name' } as unknown as TranscriptEntry
    addTranscriptEntries(ctx, CONV, [launchTitle], false)
    expect(conv.title).toBe('launch-name')

    // The user renames from the panel.
    conv.title = 'what-the-user-called-it'
    conv.titleUserSet = true
    conv.titleOrigin = 'user'
    conv.titleSetAt = Date.now()

    addTranscriptEntries(ctx, CONV, [launchTitle], true)
    expect(conv.title).toBe('what-the-user-called-it')
  })

  it('an isInitial batch no longer blanks metadata before folding', () => {
    // The reset used to clear summary/agentName/prLinks unconditionally, so any
    // field the replay did not happen to re-supply came back EMPTY.
    const store = createSqliteDriver({ type: 'sqlite', dataDir: freshDataDir() })
    const conv = makeConv()
    const ctx = ctxOver(store, conv)

    addTranscriptEntries(ctx, CONV, [summaryEntry('s1', 'a summary'), turn('t1')], false)
    expect(conv.summary).toBe('a summary')

    // A replay that carries only content -- no metadata lines at all.
    addTranscriptEntries(ctx, CONV, [turn('t1')], true)
    expect(conv.summary).toBe('a summary')
  })
})
