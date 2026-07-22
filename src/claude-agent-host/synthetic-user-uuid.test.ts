/**
 * A dashboard prompt reaches the broker twice -- the live stdin echo
 * (sendUserMessage) and, minutes later, CC's JSONL file row on a resend. Both
 * must carry the SAME uuid or the store (INSERT OR IGNORE on uuid) re-inserts
 * the file copy at the tail, and the first prompt renders LAST. These pin the
 * frozen identity that keeps the two collapsed into one row.
 */

import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { syntheticUserUuid, unifyHeadlessPromptUuids, userContentHash } from './synthetic-user-uuid'

const CONV = 'conv-xyz'

describe('syntheticUserUuid', () => {
  it('is deterministic and v5-shaped', () => {
    const a = syntheticUserUuid(CONV, 'hello')
    const b = syntheticUserUuid(CONV, 'hello')
    expect(a).toBe(b)
    expect(a[14]).toBe('5') // version nibble
  })

  it('separates by content and by conversation', () => {
    expect(syntheticUserUuid(CONV, 'a')).not.toBe(syntheticUserUuid(CONV, 'b'))
    expect(syntheticUserUuid(CONV, 'a')).not.toBe(syntheticUserUuid('other', 'a'))
  })
})

describe('unifyHeadlessPromptUuids', () => {
  it('rewrites a file-echo prompt to the same uuid as the live stdin echo', () => {
    // What sendUserMessage stamps on the LIVE echo (and stashes).
    const live = syntheticUserUuid(CONV, 'do the thing')

    // The CC JSONL file row for the SAME prompt: different shape, CC's own uuid.
    const fileEcho = {
      type: 'user',
      parentUuid: null,
      promptId: 'p1',
      uuid: '293be67b-8f71-4ecc-a29a-ec9f19a5a874', // CC v4
      message: { role: 'user', content: 'do the thing' },
    } as unknown as TranscriptEntry

    unifyHeadlessPromptUuids(CONV, [fileEcho])
    expect((fileEcho as { uuid: string }).uuid).toBe(live)
  })

  it('leaves tool-result (array content) and meta user rows alone', () => {
    const toolResult = {
      type: 'user',
      uuid: 'keep-1',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    } as unknown as TranscriptEntry
    const meta = {
      type: 'user',
      uuid: 'keep-2',
      isMeta: true,
      message: { role: 'user', content: 'system reminder' },
    } as unknown as TranscriptEntry
    const assistant = { type: 'assistant', uuid: 'keep-3', message: { content: 'x' } } as unknown as TranscriptEntry

    unifyHeadlessPromptUuids(CONV, [toolResult, meta, assistant])
    expect((toolResult as { uuid: string }).uuid).toBe('keep-1')
    expect((meta as { uuid: string }).uuid).toBe('keep-2')
    expect((assistant as { uuid: string }).uuid).toBe('keep-3')
  })

  it('is a no-op on an already-synthetic live echo (same value re-derived)', () => {
    const content = 'already stamped'
    const liveEcho = {
      type: 'user',
      uuid: syntheticUserUuid(CONV, content),
      message: { role: 'user', content },
    } as unknown as TranscriptEntry
    const before = (liveEcho as { uuid: string }).uuid
    unifyHeadlessPromptUuids(CONV, [liveEcho])
    expect((liveEcho as { uuid: string }).uuid).toBe(before)
  })
})

describe('userContentHash', () => {
  it('is the stash key -- stable per content', () => {
    expect(userContentHash('hi')).toBe(userContentHash('hi'))
    expect(userContentHash('hi')).not.toBe(userContentHash('ho'))
  })
})
