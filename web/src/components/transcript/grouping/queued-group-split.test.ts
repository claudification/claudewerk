/**
 * @vitest-environment node
 */
/**
 * `queued` is a GROUP flag, but queueing is a PER-MESSAGE fact.
 *
 * Consecutive user messages merge into one user group, and the whole group is
 * what gets hoisted to the bottom rail with the amber `queued` badge. So the
 * moment a still-queued message shares a group with a message that is already
 * being worked on, the transcript claims BOTH are queued -- rendered as one
 * joined bubble, sitting at the bottom, when only the last one is actually
 * waiting. (Jonas, 2026-07-28: "the whole batch gets joined into one message
 * and the whole thing looks like it's all queued now instead of just the last
 * message.")
 *
 * Two rules keep the flag honest, and both are needed -- either alone leaves a
 * path back into the bug:
 *   1. Flagging SPLITS the group, so only the enqueued message carries it.
 *   2. A queued group is CLOSED to merges, so the next message cannot join it
 *      and re-inherit the badge.
 */

import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import { processEntry } from './process-entry'
import type { DisplayGroup, GroupingState } from './types'

function group(entries: TranscriptEntry[]): GroupingState {
  const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
  for (const e of entries) processEntry(e, state)
  return state
}

function userEntry(content: string | { type: 'text'; text: string }[], seq?: number): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-07-28T05:38:00.000Z',
    ...(seq !== undefined ? { seq } : {}),
    message: { role: 'user', content },
  } as unknown as TranscriptEntry
}

function queueOp(operation: string, content?: string): TranscriptEntry {
  return {
    type: 'queue-operation',
    timestamp: '2026-07-28T05:38:01.000Z',
    operation,
    ...(content !== undefined ? { content } : {}),
  } as unknown as TranscriptEntry
}

/** The string messages a group renders, in order. */
const texts = (g: DisplayGroup): unknown[] =>
  g.entries.map(e => (e as unknown as { message?: { content?: unknown } }).message?.content)

const queuedTexts = (groups: DisplayGroup[]): unknown[] => groups.filter(g => g.queued).flatMap(texts)

describe('queued flag stays on the message that is actually queued', () => {
  // THE REPORTED BUG. `first` was already taken by CC (its dequeue arrived), so
  // it is being worked on, not waiting. `second` then merges into the same user
  // group -- and flagging that group dragged `first` down to the queued rail
  // with it.
  it('does not re-queue a message that was already dequeued', () => {
    const { groups } = group([
      userEntry('first'),
      queueOp('enqueue', 'first'),
      queueOp('dequeue'),
      userEntry('second'),
      queueOp('enqueue', 'second'),
    ])

    expect(queuedTexts(groups)).toEqual(['second'])
  })

  // Rule 2 on its own: `first` is STILL queued when `second` arrives, so the
  // merge must not happen in the first place.
  it('keeps two messages queued back-to-back in separate groups', () => {
    const { groups } = group([
      userEntry('first'),
      queueOp('enqueue', 'first'),
      userEntry('second'),
      queueOp('enqueue', 'second'),
    ])

    expect(queuedTexts(groups)).toEqual(['first', 'second'])
    // ...and still exactly one copy of each: the split must not resurrect the
    // duplicate-synthetic bug it replaced.
    expect(groups.flatMap(texts)).toEqual(['first', 'second'])
  })

  // Rule 1 on its own: the enqueued message is not at entries[0], because an
  // interrupt row merged ahead of it. Only the message goes to the queued rail.
  it('splits a queued message out from rows that merged ahead of it', () => {
    const { groups } = group([
      userEntry([{ type: 'text', text: '[Request interrupted by user]' }]),
      userEntry('the real message'),
      queueOp('enqueue', 'the real message'),
    ])

    expect(queuedTexts(groups)).toEqual(['the real message'])
    expect(groups.flatMap(texts)).toHaveLength(2)
  })

  it('splits a queued message out from rows that merged behind it', () => {
    const { groups } = group([
      userEntry('the real message'),
      userEntry([{ type: 'text', text: 'trailing row' }]),
      queueOp('enqueue', 'the real message'),
    ])

    expect(queuedTexts(groups)).toEqual(['the real message'])
    expect(groups.flatMap(texts)).toHaveLength(2)
  })

  it('leaves a lone queued message as its own group, unsplit', () => {
    const { groups } = group([userEntry('only one'), queueOp('enqueue', 'only one')])

    expect(groups).toHaveLength(1)
    expect(groups[0].queued).toBe(true)
  })

  // The drain path still has to work per-message once groups are split: a single
  // dequeue clears the OLDEST queued message, not all of them.
  it('clears the oldest queued message first, one drain at a time', () => {
    const { groups } = group([
      userEntry('first'),
      queueOp('enqueue', 'first'),
      userEntry('second'),
      queueOp('enqueue', 'second'),
      queueOp('dequeue'),
    ])

    expect(queuedTexts(groups)).toEqual(['second'])
  })

  it('clears every queued message on popAll', () => {
    const { groups } = group([
      userEntry('first'),
      queueOp('enqueue', 'first'),
      userEntry('second'),
      queueOp('enqueue', 'second'),
      queueOp('popAll'),
    ])

    expect(queuedTexts(groups)).toEqual([])
  })
})
