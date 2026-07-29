import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { cutKnownPrefix } from './resend-cursor'

const e = (uuid: string): TranscriptEntry => ({ type: 'user', uuid }) as unknown as TranscriptEntry
const uuids = (entries: TranscriptEntry[]) => entries.map(x => x.uuid)

describe('cutKnownPrefix', () => {
  it('sends only what follows the newest entry the broker already has', () => {
    const cut = cutKnownPrefix([e('a'), e('b'), e('c'), e('d')], new Set(['a', 'b']))
    expect(uuids(cut.entries)).toEqual(['c', 'd'])
    expect(cut).toMatchObject({ skipped: 2, matched: true })
  })

  it('sends nothing when the broker is already current', () => {
    const cut = cutKnownPrefix([e('a'), e('b')], new Set(['a', 'b']))
    expect(cut.entries).toEqual([])
    expect(cut.matched).toBe(true)
  })

  it('falls back to a FULL replay when it recognizes nothing', () => {
    // Compaction rewrote the file, or this is a conversation the broker has no
    // rows for. Old behaviour is the fallback -- never a dropped entry.
    const cut = cutKnownPrefix([e('x'), e('y')], new Set(['a', 'b']))
    expect(uuids(cut.entries)).toEqual(['x', 'y'])
    expect(cut).toMatchObject({ skipped: 0, matched: false })
  })

  it('replays across a GAP rather than filtering set members individually', () => {
    // 'b' is missing from the broker. Cutting at the last KNOWN entry re-sends
    // it; filtering member-by-member would skip 'a' and 'c' and leave the hole
    // the resend exists to close.
    const cut = cutKnownPrefix([e('a'), e('b'), e('c'), e('d')], new Set(['a', 'c']))
    expect(uuids(cut.entries)).toEqual(['d'])
  })

  it('is a no-op without a cursor, so an uncursored request still replays fully', () => {
    expect(cutKnownPrefix([e('a')], null).entries).toHaveLength(1)
    expect(cutKnownPrefix([e('a')], new Set()).entries).toHaveLength(1)
  })

  it('ignores entries that carry no uuid', () => {
    const undated = { type: 'custom-title' } as unknown as TranscriptEntry
    const cut = cutKnownPrefix([undated, e('a'), e('b')], new Set(['a']))
    expect(uuids(cut.entries)).toEqual(['b'])
  })

  it('handles an empty batch', () => {
    expect(cutKnownPrefix([], new Set(['a'])).entries).toEqual([])
  })
})
