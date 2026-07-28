import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { splitCoalescedPrompts } from './coalesced-prompt-split'
import { syntheticUserUuid } from './synthetic-user-uuid'

const CONV = 'daf1f369-76e7-42d4-b2c5-bc7629b324ef'

const enqueue = (content: string, timestamp: string): TranscriptEntry =>
  ({ type: 'queue-operation', operation: 'enqueue', content, timestamp }) as unknown as TranscriptEntry

const dequeue = (timestamp: string): TranscriptEntry =>
  ({ type: 'queue-operation', operation: 'dequeue', timestamp }) as unknown as TranscriptEntry

const prompt = (content: unknown, timestamp: string): TranscriptEntry =>
  ({ type: 'user', message: { role: 'user', content }, timestamp }) as unknown as TranscriptEntry

const contents = (entries: TranscriptEntry[]): unknown[] =>
  entries
    .filter(e => e.type === 'user')
    .map(e => ((e as Record<string, unknown>).message as { content?: unknown }).content)

describe('splitCoalescedPrompts', () => {
  // THE PRODUCTION CASE (conv daf1f369, 2026-07-28). Two prompts sent while the
  // agent was busy; CC popped BOTH at the next turn and wrote ONE JSONL row
  // joining them with a newline. Hashing that joined string produced a THIRD
  // uuid matching neither live echo, so the broker's INSERT OR IGNORE missed and
  // the row landed at MAX(seq)+1 -- a duplicate, 432s displaced.
  it('splits a coalesced row back into the prompts that were enqueued', () => {
    const batch = [
      enqueue('all ok?', '2026-07-28T05:38:00.846Z'),
      enqueue('(check pending background processes etc)', '2026-07-28T05:38:07.737Z'),
      dequeue('2026-07-28T05:38:20.230Z'),
      prompt('all ok?\n(check pending background processes etc)', '2026-07-28T05:38:20.238Z'),
    ]
    expect(contents(splitCoalescedPrompts(batch))).toEqual(['all ok?', '(check pending background processes etc)'])
  })

  it('gives each split prompt the uuid its live echo already carries', () => {
    const batch = [
      enqueue('all ok?', '2026-07-28T05:38:00.846Z'),
      enqueue('(check pending background processes etc)', '2026-07-28T05:38:07.737Z'),
      prompt('all ok?\n(check pending background processes etc)', '2026-07-28T05:38:20.238Z'),
    ]
    const users = splitCoalescedPrompts(batch, CONV).filter(e => e.type === 'user')
    expect(users.map(e => e.uuid)).toEqual([
      syntheticUserUuid(CONV, 'all ok?'),
      syntheticUserUuid(CONV, '(check pending background processes etc)'),
    ])
  })

  // Each half must land where it was SENT, not where the turn happened to pop --
  // otherwise a prompt recovered after a socket blip renders minutes off.
  it('dates each split prompt from its own enqueue', () => {
    const batch = [
      enqueue('a', '2026-07-28T05:38:00.846Z'),
      enqueue('b', '2026-07-28T05:38:07.737Z'),
      prompt('a\nb', '2026-07-28T05:38:20.238Z'),
    ]
    const users = splitCoalescedPrompts(batch).filter(e => e.type === 'user')
    expect(users.map(e => e.timestamp)).toEqual(['2026-07-28T05:38:00.846Z', '2026-07-28T05:38:07.737Z'])
  })

  // The reason blind newline-splitting is NOT the fix: a single prompt is very
  // often multi-line, and shredding it would be a far worse bug than the dupe.
  it('leaves a multi-line prompt that was enqueued verbatim alone', () => {
    const multi = 'line one\nline two\nline three'
    const batch = [enqueue(multi, '2026-07-28T05:38:00.846Z'), prompt(multi, '2026-07-28T05:38:20.238Z')]
    expect(contents(splitCoalescedPrompts(batch))).toEqual([multi])
  })

  it('leaves a prompt that does not decompose into enqueued chunks alone', () => {
    const batch = [
      enqueue('a', '2026-07-28T05:38:00.846Z'),
      prompt('a\nsomething else entirely', '2026-07-28T05:38:20.238Z'),
    ]
    expect(contents(splitCoalescedPrompts(batch))).toEqual(['a\nsomething else entirely'])
  })

  it('leaves the batch alone when it carries no queue operations', () => {
    const batch = [prompt('a\nb', '2026-07-28T05:38:20.238Z')]
    expect(contents(splitCoalescedPrompts(batch))).toEqual(['a\nb'])
  })

  it('ignores tool-result rows, which are arrays and never prompts', () => {
    const toolResult = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
    const batch = [enqueue('a', '2026-07-28T05:38:00.846Z'), prompt(toolResult, '2026-07-28T05:38:20.238Z')]
    expect(contents(splitCoalescedPrompts(batch))).toEqual([toolResult])
  })

  // A resend re-reads the WHOLE file, so several coalesced turns arrive in one
  // batch. Each must consume its own run of enqueues, not the first match.
  it('handles two coalesced turns in the same batch', () => {
    const batch = [
      enqueue('a', '2026-07-28T05:38:00.000Z'),
      enqueue('b', '2026-07-28T05:38:01.000Z'),
      prompt('a\nb', '2026-07-28T05:38:02.000Z'),
      enqueue('c', '2026-07-28T05:39:00.000Z'),
      enqueue('d', '2026-07-28T05:39:01.000Z'),
      prompt('c\nd', '2026-07-28T05:39:02.000Z'),
    ]
    expect(contents(splitCoalescedPrompts(batch))).toEqual(['a', 'b', 'c', 'd'])
  })

  // Same text sent twice is two separate enqueues, and the run has to be able to
  // use both -- a used-once set keyed on content would swallow the repeat.
  it('splits a coalesced pair of identical prompts', () => {
    const batch = [
      enqueue('again', '2026-07-28T05:38:00.000Z'),
      enqueue('again', '2026-07-28T05:38:01.000Z'),
      prompt('again\nagain', '2026-07-28T05:38:02.000Z'),
    ]
    expect(contents(splitCoalescedPrompts(batch))).toEqual(['again', 'again'])
  })

  it('keeps every non-user entry in place', () => {
    const batch = [
      enqueue('a', '2026-07-28T05:38:00.000Z'),
      enqueue('b', '2026-07-28T05:38:01.000Z'),
      dequeue('2026-07-28T05:38:02.000Z'),
      prompt('a\nb', '2026-07-28T05:38:02.100Z'),
    ]
    const out = splitCoalescedPrompts(batch)
    expect(out.map(e => e.type)).toEqual(['queue-operation', 'queue-operation', 'queue-operation', 'user', 'user'])
  })
})
