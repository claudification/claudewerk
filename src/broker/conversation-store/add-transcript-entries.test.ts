import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../../shared/protocol'
import { addTranscriptEntries } from './add-transcript-entries'
import { makeTestContext } from './test-context'

const e = (o: Record<string, unknown>): TranscriptEntry => o as unknown as TranscriptEntry

/** Minimal in-memory context -- no store, no registered conversation. Exercises
 *  the parent cache + scope guard without the full conversation-store closure. */
const minimalCtx = makeTestContext

describe('addTranscriptEntries scope guard (Checkpoint A)', () => {
  it('strips agent-scoped entries from the parent cache, keeps real parent entries', () => {
    const ctx = minimalCtx()
    addTranscriptEntries(
      ctx,
      'conv1',
      [
        e({ type: 'user', uuid: 'p1', message: { role: 'user', content: 'hi' } }),
        e({ type: 'system', subtype: 'task_progress', uuid: 'a1', task_id: 'task_1' }),
        e({ type: 'assistant', uuid: 'p2', message: { role: 'assistant', content: [] } }),
        e({ type: 'assistant', uuid: 'b1', parent_tool_use_id: 'toolu_2' }),
      ],
      false,
    )
    const cached = ctx.transcriptCache.get('conv1') || []
    expect(cached.map(x => x.uuid)).toEqual(['p1', 'p2'])
  })

  it('an all-agent batch leaves the parent cache empty', () => {
    const ctx = minimalCtx()
    addTranscriptEntries(
      ctx,
      'conv1',
      [
        e({ type: 'system', subtype: 'task_progress', uuid: 'a1', task_id: 'task_1' }),
        e({ type: 'system', subtype: 'task_notification', uuid: 'a2', task_id: 'task_1' }),
      ],
      false,
    )
    expect(ctx.transcriptCache.get('conv1') ?? []).toHaveLength(0)
  })

  it('a clean parent batch passes through untouched', () => {
    const ctx = minimalCtx()
    addTranscriptEntries(ctx, 'conv1', [e({ type: 'user', uuid: 'p1' }), e({ type: 'assistant', uuid: 'p2' })], false)
    expect((ctx.transcriptCache.get('conv1') || []).map(x => x.uuid)).toEqual(['p1', 'p2'])
  })
})
