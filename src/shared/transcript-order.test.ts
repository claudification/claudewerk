import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from './protocol'
import { insertTranscriptEntriesInOrder, sortTranscriptEntries } from './transcript-order'

const at = (uuid: string, seconds: number, seq?: number): TranscriptEntry =>
  ({
    type: 'user',
    uuid,
    seq,
    timestamp: new Date(Date.UTC(2026, 6, 22, 13, 0, seconds)).toISOString(),
  }) as unknown as TranscriptEntry

/** No timestamp at all -- the shape launch/attachment/synthetic rows can have. */
const undated = (uuid: string, seq?: number): TranscriptEntry =>
  ({ type: 'user', uuid, seq }) as unknown as TranscriptEntry

const ids = (entries: TranscriptEntry[]): string[] => entries.map(e => e.uuid as string)

describe('sortTranscriptEntries', () => {
  it('orders by timestamp, not by arrival', () => {
    expect(ids(sortTranscriptEntries([at('c', 30), at('a', 10), at('b', 20)]))).toEqual(['a', 'b', 'c'])
  })

  it('breaks same-millisecond ties on seq', () => {
    expect(ids(sortTranscriptEntries([at('second', 10, 2), at('first', 10, 1)]))).toEqual(['first', 'second'])
  })

  // The failure mode that made a Date.now() fallback unusable: an undated
  // entry's key must not float, or the comparator stops being a total order.
  it('keeps undated entries pinned to their arrival position', () => {
    expect(ids(sortTranscriptEntries([at('a', 10), undated('mid'), at('c', 30)]))).toEqual(['a', 'mid', 'c'])
  })

  it('is stable across repeated sorts', () => {
    const once = sortTranscriptEntries([at('a', 10), undated('x'), at('c', 30), undated('y')])
    expect(ids(sortTranscriptEntries(once))).toEqual(ids(once))
  })
})

describe('insertTranscriptEntriesInOrder', () => {
  it('pushes a live entry that belongs at the end', () => {
    const list = [at('a', 10), at('b', 20)]
    insertTranscriptEntriesInOrder(list, [at('c', 30)])
    expect(ids(list)).toEqual(['a', 'b', 'c'])
  })

  // The production case: recovered from the JSONL long after it happened.
  it('splices a late gap-fill into its chronological position', () => {
    const list = [at('a', 10), at('c', 30), at('d', 40)]
    insertTranscriptEntriesInOrder(list, [at('b', 20)])
    expect(ids(list)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('places a gap-fill after same-second entries with a lower seq', () => {
    const list = [at('a', 10, 1), at('c', 10, 3)]
    insertTranscriptEntriesInOrder(list, [at('b', 10, 2)])
    expect(ids(list)).toEqual(['a', 'b', 'c'])
  })

  it('appends an undated entry rather than guessing a position', () => {
    const list = [at('a', 10), at('b', 20)]
    insertTranscriptEntriesInOrder(list, [undated('x')])
    expect(ids(list)).toEqual(['a', 'b', 'x'])
  })

  it('handles a batch that is itself out of order', () => {
    const list = [at('a', 10)]
    insertTranscriptEntriesInOrder(list, [at('d', 40), at('b', 20), at('c', 30)])
    expect(ids(list)).toEqual(['a', 'b', 'c', 'd'])
  })
})
