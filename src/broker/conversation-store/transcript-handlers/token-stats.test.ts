/**
 * THE STATS TABLE's third producer, the behaviour half.
 *
 * What must stay true: four metrics land per assistant message, they are the
 * per-MESSAGE deltas and not a running total, the object is keyed on the
 * conversation id so a `/rename` moves the label instead of forking the series,
 * and a conversation with no sentinel is refused rather than filed onto a
 * fictional node.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation, TranscriptEntry } from '../../../shared/protocol'
import type { StatMetric } from '../../../shared/stats'
import type { PerMessageTokenSample } from '../../../shared/token-usage'
import { readStatsByKind } from '../../stats/read'
import { closeStatsStore, flushStats, initStatsStore, recordStat } from '../../stats/store'
import { createStore } from '../../store'
import { addTranscriptEntries } from '../add-transcript-entries'
import { makeStoreBackedContext } from '../test-context'
import { recordConversationTokenStats } from './token-stats'

const NOW = Date.now()
const SEC = 1_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'token-stats-test-'))
  initStatsStore(dir)
})
afterEach(() => {
  closeStatsStore()
  rmSync(dir, { recursive: true, force: true })
})

/** Only the four fields the producer reads -- the real `Conversation` is ~200
 *  fields wide and none of the rest changes what lands. */
function conv(over: Partial<Conversation> = {}): Conversation {
  return { hostSentinelId: 'studio', title: 'wall stats', ...over } as Conversation
}

function sample(over: Partial<PerMessageTokenSample> = {}): PerMessageTokenSample {
  return {
    model: 'claude-opus-5',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 300,
    cacheWrite5mTokens: 200,
    cacheWrite1hTokens: 100,
    ...over,
  }
}

function valuesOf(metric: StatMetric, name = 'conv-1'): number[] {
  const series = readStatsByKind('conversation', metric, 0).find(s => s.ref.name === name)
  return series?.points.map(p => p.value) ?? []
}

describe('what lands', () => {
  test('one assistant message files all four metrics against the conversation', () => {
    recordConversationTokenStats('conv-1', conv(), NOW, sample())
    flushStats()

    expect(valuesOf('tokens_in_count')).toEqual([100])
    expect(valuesOf('tokens_out_count')).toEqual([20])
    expect(valuesOf('cache_read_count')).toEqual([5_000])
    expect(valuesOf('cache_write_count')).toEqual([300])
  })

  test('the object is (sentinel, conversation, conversationId) with the title as label', () => {
    recordConversationTokenStats('conv-1', conv(), NOW, sample())
    flushStats()

    const all = readStatsByKind('conversation', 'tokens_in_count', 0)
    expect(all).toHaveLength(1)
    expect(all[0]?.ref).toEqual({ nodeId: 'studio', kind: 'conversation', name: 'conv-1', label: 'wall stats' })
  })

  test('cache_write_count is the 5m+1h TOTAL -- the TTL split stays in token_samples', () => {
    recordConversationTokenStats('conv-1', conv(), NOW, sample({ cacheWriteTokens: 300 }))
    flushStats()

    expect(valuesOf('cache_write_count')).toEqual([300])
  })

  // Flow, not gauge: the store must hold what each message billed, so a reader
  // can sum a window. A running total would make every read of a window wrong.
  test('values are per-MESSAGE deltas, never a running total', () => {
    recordConversationTokenStats('conv-1', conv(), NOW - 2 * SEC, sample({ outputTokens: 10 }))
    recordConversationTokenStats('conv-1', conv(), NOW - SEC, sample({ outputTokens: 30 }))
    recordConversationTokenStats('conv-1', conv(), NOW, sample({ outputTokens: 5 }))
    flushStats()

    expect(valuesOf('tokens_out_count')).toEqual([10, 30, 5])
  })

  // A message that read nothing from the cache really did read zero. Skipping it
  // would leave a hole that reads as "no message happened here".
  test('a zero is filed, not skipped', () => {
    recordConversationTokenStats('conv-1', conv(), NOW, sample({ cacheReadTokens: 0 }))
    flushStats()

    expect(valuesOf('cache_read_count')).toEqual([0])
  })
})

describe('identity', () => {
  test('renaming the conversation updates the label instead of forking the series', () => {
    recordConversationTokenStats('conv-1', conv({ title: 'old' }), NOW - SEC, sample({ outputTokens: 1 }))
    flushStats()
    recordConversationTokenStats('conv-1', conv({ title: 'new' }), NOW, sample({ outputTokens: 2 }))
    flushStats()

    const all = readStatsByKind('conversation', 'tokens_out_count', 0)
    expect(all).toHaveLength(1)
    expect(all[0]?.ref.label).toBe('new')
    expect(all[0]?.points.map(p => p.value)).toEqual([1, 2])
  })

  test('two conversations on one sentinel are two objects', () => {
    recordConversationTokenStats('conv-1', conv(), NOW, sample({ outputTokens: 1 }))
    recordConversationTokenStats('conv-2', conv(), NOW, sample({ outputTokens: 2 }))
    flushStats()

    expect(readStatsByKind('conversation', 'tokens_out_count', 0)).toHaveLength(2)
    expect(valuesOf('tokens_out_count', 'conv-2')).toEqual([2])
  })

  // nodeId is identity in this store. `''` would collapse every unhosted
  // conversation onto one fictional node and silently merge their series.
  test('a conversation with no sentinel files NOTHING rather than inventing a node', () => {
    recordConversationTokenStats('conv-1', conv({ hostSentinelId: undefined }), NOW, sample())
    flushStats()

    expect(readStatsByKind('conversation', 'tokens_in_count', 0)).toEqual([])
  })

  test('a conversation with no title is stored with no label rather than an empty one', () => {
    recordConversationTokenStats('conv-1', conv({ title: undefined }), NOW, sample())
    flushStats()

    expect(readStatsByKind('conversation', 'tokens_in_count', 0)[0]?.ref.label).toBeUndefined()
  })

  // The store's OR IGNORE is the second line of defence behind the token store's
  // uuid de-dup: a replay that somehow reaches the producer still cannot inflate.
  test('re-filing the same message is ignored rather than counted twice', () => {
    recordConversationTokenStats('conv-1', conv(), NOW, sample())
    flushStats()
    recordConversationTokenStats('conv-1', conv(), NOW, sample())
    flushStats()

    expect(valuesOf('tokens_in_count')).toEqual([100])
  })
})

describe('coexistence with the wall producers', () => {
  // The whole point of one narrow table: a token series and a CPU series live
  // side by side, and neither kind's read sees the other.
  test('conversation stats do not leak into the node or profile kinds', () => {
    recordStat({ nodeId: 'studio', kind: 'node', name: 'studio' }, 'cpu_percent', 42, NOW)
    recordConversationTokenStats('conv-1', conv(), NOW, sample())
    flushStats()

    expect(readStatsByKind('node', 'cpu_percent', 0)).toHaveLength(1)
    expect(readStatsByKind('node', 'tokens_in_count', 0)).toEqual([])
    expect(readStatsByKind('conversation', 'cpu_percent', 0)).toEqual([])
    expect(readStatsByKind('conversation', 'tokens_in_count', 0)).toHaveLength(1)
  })

  test('the series survives a restart, like every other producer', () => {
    recordConversationTokenStats('conv-1', conv(), NOW, sample())
    closeStatsStore()
    initStatsStore(dir)

    expect(valuesOf('tokens_in_count')).toEqual([100])
  })
})

/**
 * The seam itself, driven from the top. `token-stats-wiring.test.ts` asserts the
 * call EXISTS in `add-transcript-entries.ts`; only this proves it FIRES -- an
 * unreached line reads identically in source.
 */
describe('the seam', () => {
  function assistantEntry(uuid: string, out: number): TranscriptEntry {
    return {
      type: 'assistant',
      uuid,
      timestamp: new Date(NOW).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 5_000 },
      },
    } as unknown as TranscriptEntry
  }

  /** A conversation complete enough for the FULL ingest path -- the other
   *  handlers in the batch (bg-tasks, mentions, aggregates) read fields the
   *  producer never touches, and an absent one throws before the seam is
   *  reached. */
  function seamContext() {
    const driver = createStore({ type: 'memory' })
    driver.init()
    const c = conv({
      bgTasks: [],
      subagents: [],
      teammates: [],
      stats: {
        toolCallCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreation: 0,
        totalCacheWrite5m: 0,
        totalCacheWrite1h: 0,
        totalCacheRead: 0,
        compactionCount: 0,
      },
    } as unknown as Partial<Conversation>)
    return makeStoreBackedContext(driver, 'conv-1', c)
  }

  test('ingesting an assistant entry files the four metrics without any extra call', () => {
    addTranscriptEntries(seamContext(), 'conv-1', [assistantEntry('u1', 42)], false)
    flushStats()

    expect(valuesOf('tokens_in_count')).toEqual([100])
    expect(valuesOf('tokens_out_count')).toEqual([42])
    expect(valuesOf('cache_read_count')).toEqual([5_000])
    expect(valuesOf('cache_write_count')).toEqual([0])
  })

  // The token store de-dups on (conversation_id, uuid) and the producer only
  // runs for a NEW row, so a full-file re-read on reconnect cannot inflate the
  // series -- the failure that would make every token chart drift upward on
  // every restart.
  test('a transcript re-read does not double-count', () => {
    const ctx = seamContext()
    addTranscriptEntries(ctx, 'conv-1', [assistantEntry('u1', 42)], false)
    addTranscriptEntries(ctx, 'conv-1', [assistantEntry('u1', 42)], true)
    flushStats()

    expect(valuesOf('tokens_out_count')).toEqual([42])
  })
})
