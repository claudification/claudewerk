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

/** Millisecond-precision variant -- the jitter cases live well under one second. */
const atMs = (uuid: string, ms: number, seq: number): TranscriptEntry =>
  ({
    type: 'user',
    uuid,
    seq,
    timestamp: new Date(Date.UTC(2026, 6, 22, 13, 0, 0, 0) + ms).toISOString(),
  }) as unknown as TranscriptEntry

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

  // THE SKILL-CHIP REGRESSION (2026-07-23). CC stamps the injected skill BODY
  // 150-800ms EARLIER than the Skill tool_result that names it -- measured at
  // 15 of 15 invocations in the production store. Sorting on the raw clock
  // swapped them, the grouper never saw `toolUseResult.commandName` before the
  // body, and every skill rendered as a fat user bubble instead of a /chip.
  it('does not reorder a sub-second inversion between entries that arrived in order', () => {
    const invoke = atMs('invoke', 5671, 397)
    const body = atMs('body', 5016, 398)
    expect(ids(sortTranscriptEntries([invoke, body]))).toEqual(['invoke', 'body'])
  })

  it('holds the line on a whole run of jittery in-order entries', () => {
    const run = [atMs('a', 3000, 10), atMs('b', 2100, 11), atMs('c', 2500, 12), atMs('d', 1900, 13)]
    expect(ids(sortTranscriptEntries(run))).toEqual(['a', 'b', 'c', 'd'])
  })

  // ...while the case the clock ordering exists for still works: a headless
  // gap-fill recovered from the JSONL lands MINUTES late at MAX(seq)+1.
  it('still places a minutes-late gap-fill chronologically', () => {
    const early = at('early', 10, 1)
    const later = at('later', 3600, 2)
    const gapFill = at('gap-fill', 20, 999)
    expect(ids(sortTranscriptEntries([early, later, gapFill]))).toEqual(['early', 'gap-fill', 'later'])
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

  // Same rule as the sort: a live entry whose clock reads slightly BEHIND the
  // one before it arrived in order and belongs at the tail, not spliced back.
  it('appends a live entry that is only jitter-behind the tail', () => {
    const list = [atMs('invoke', 5671, 397)]
    insertTranscriptEntriesInOrder(list, [atMs('body', 5016, 398)])
    expect(ids(list)).toEqual(['invoke', 'body'])
  })
})
