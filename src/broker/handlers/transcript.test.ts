import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'
import { conversationModel, streamDelta, transcriptEntries } from './transcript'

const e = (o: Record<string, unknown>): TranscriptEntry => o as unknown as TranscriptEntry

interface AddCall {
  conversationId: string
  entries: TranscriptEntry[]
  isInitial: boolean
}
interface SubCall extends AddCall {
  agentId: string
}
interface BroadcastCall {
  channel: string
  agentId?: string
  message: unknown
}

function fakeCtx() {
  const parentAdds: AddCall[] = []
  const subAdds: SubCall[] = []
  const broadcasts: BroadcastCall[] = []
  const ctx = {
    ws: { data: {} },
    conversations: {
      // Mirrors the real contract: returns the entries the caller should
      // broadcast. This fake accepts everything; the "already stored" case is
      // covered against a real store in add-transcript-entries.test.ts.
      addTranscriptEntries: (conversationId: string, entries: TranscriptEntry[], isInitial: boolean) => {
        parentAdds.push({ conversationId, entries, isInitial })
        return entries
      },
      addSubagentTranscriptEntries: (
        conversationId: string,
        agentId: string,
        entries: TranscriptEntry[],
        isInitial: boolean,
      ) => subAdds.push({ conversationId, agentId, entries, isInitial }),
      broadcastToChannel: (channel: string, _conversationId: string, message: unknown, agentId?: string) =>
        broadcasts.push({ channel, agentId, message }),
    },
  } as unknown as HandlerContext
  return { ctx, parentAdds, subAdds, broadcasts }
}

describe('transcriptEntries divert (Checkpoint A)', () => {
  it('routes parent entries to the parent ingest and agent chatter to its sub-scope', () => {
    const { ctx, parentAdds, subAdds, broadcasts } = fakeCtx()
    transcriptEntries(ctx, {
      conversationId: 'conv1',
      isInitial: false,
      entries: [
        e({ type: 'assistant', uuid: 'p1' }),
        e({ type: 'system', subtype: 'task_progress', uuid: 'a1', task_id: 'task_1' }),
        e({ type: 'system', subtype: 'task_progress', uuid: 'a2', task_id: 'task_1' }),
      ],
    } as unknown as MessageData)

    expect(parentAdds).toHaveLength(1)
    expect(parentAdds[0].entries.map(x => x.uuid)).toEqual(['p1'])

    expect(subAdds).toHaveLength(1)
    expect(subAdds[0].agentId).toBe('task_1')
    expect(subAdds[0].entries.map(x => x.uuid)).toEqual(['a1', 'a2'])

    // Parent channel broadcast carries only the parent entry (zero agent chatter).
    const parentBroadcast = broadcasts.find(b => b.channel === 'conversation:transcript')
    expect((parentBroadcast?.message as { entries: TranscriptEntry[] }).entries.map(x => x.uuid)).toEqual(['p1'])
    const subBroadcast = broadcasts.find(b => b.channel === 'conversation:subagent_transcript')
    expect(subBroadcast?.agentId).toBe('task_1')
  })

  it('an all-parent batch never touches the subagent path', () => {
    const { ctx, parentAdds, subAdds } = fakeCtx()
    transcriptEntries(ctx, {
      conversationId: 'conv1',
      entries: [e({ type: 'user', uuid: 'p1' })],
    } as unknown as MessageData)
    expect(parentAdds).toHaveLength(1)
    expect(subAdds).toHaveLength(0)
  })

  it('an all-agent batch skips the parent ingest entirely (no empty parent broadcast)', () => {
    const { ctx, parentAdds, subAdds, broadcasts } = fakeCtx()
    transcriptEntries(ctx, {
      conversationId: 'conv1',
      entries: [e({ type: 'system', subtype: 'task_progress', uuid: 'a1', task_id: 'task_1' })],
    } as unknown as MessageData)
    expect(parentAdds).toHaveLength(0)
    expect(subAdds).toHaveLength(1)
    expect(broadcasts.some(b => b.channel === 'conversation:transcript')).toBe(false)
  })
})

interface ScopedCall {
  message: Record<string, unknown>
  project: string
}

function fakeStreamCtx(transcriptSubs: number) {
  const channelBroadcasts: BroadcastCall[] = []
  const scopedBroadcasts: ScopedCall[] = []
  const debugLogs: string[] = []
  const ctx = {
    ws: { data: {} },
    log: {
      debug: (msg: string) => debugLogs.push(msg),
      info: () => {},
      error: () => {},
      warn: () => {},
    },
    // broadcastScoped MUST NOT be called for stream_delta anymore -- record so
    // the test can assert it stayed untouched (no project-wide fan-out, no ring stamp).
    broadcastScoped: (message: Record<string, unknown>, project: string) => scopedBroadcasts.push({ message, project }),
    conversations: {
      getConversation: (_id: string) => ({ project: 'proj://x' }),
      getChannelSubscribers: (_channel: string, _conversationId: string) => new Set(Array(transcriptSubs).fill(0)),
      broadcastToChannel: (channel: string, _conversationId: string, message: unknown, agentId?: string) =>
        channelBroadcasts.push({ channel, agentId, message }),
    },
  } as unknown as HandlerContext
  return { ctx, channelBroadcasts, scopedBroadcasts, debugLogs }
}

describe('streamDelta gate (T-2, B-H2)', () => {
  it('routes deltas to the conversation:transcript channel, never project-wide broadcastScoped', () => {
    const { ctx, channelBroadcasts, scopedBroadcasts } = fakeStreamCtx(2)
    streamDelta(ctx, {
      conversationId: 'conv1',
      event: { type: 'content_block_delta', delta: { text: 'hi' } },
    } as unknown as MessageData)

    expect(scopedBroadcasts).toHaveLength(0)
    expect(channelBroadcasts).toHaveLength(1)
    expect(channelBroadcasts[0].channel).toBe('conversation:transcript')
    expect(channelBroadcasts[0].message).toMatchObject({
      type: 'stream_delta',
      conversationId: 'conv1',
      event: { type: 'content_block_delta' },
    })
  })

  it('still channel-broadcasts when there are zero transcript viewers (the channel just has no subscribers)', () => {
    // The gate is the channel subscription itself, enforced inside broadcastToChannel.
    // The handler always hands the delta to the channel; with no viewers it fans out to nobody.
    // Distinct conversationId so the module-level per-conversation log throttle
    // (5s) doesn't suppress the line after the earlier test's 'conv1' delta.
    const { ctx, channelBroadcasts, debugLogs } = fakeStreamCtx(0)
    streamDelta(ctx, { conversationId: 'conv-zero', event: { type: 'ping' } } as unknown as MessageData)
    expect(channelBroadcasts).toHaveLength(1)
    expect(debugLogs.some(l => l.includes('dropped(no viewer)'))).toBe(true)
  })

  it('ignores a delta with no resolvable conversation project', () => {
    const { channelBroadcasts, scopedBroadcasts } = fakeStreamCtx(1)
    const ctx = {
      ws: { data: {} },
      log: { debug: () => {} },
      conversations: { getConversation: () => undefined },
    } as unknown as HandlerContext
    streamDelta(ctx, { conversationId: 'gone', event: { type: 'ping' } } as unknown as MessageData)
    expect(channelBroadcasts).toHaveLength(0)
    expect(scopedBroadcasts).toHaveLength(0)
  })
})

describe('conversationModel handler', () => {
  function fakeModelCtx(initial: { model?: string; conversationInfo?: Record<string, unknown> }) {
    const conv = {
      id: 'conv-model',
      model: initial.model,
      conversationInfo: initial.conversationInfo,
    } as Record<string, unknown>
    const persisted: string[] = []
    const broadcasts: string[] = []
    const infoLogs: string[] = []
    const ctx = {
      ws: { data: { conversationId: 'conv-model' } },
      log: { info: (m: string) => infoLogs.push(m), debug: () => {} },
      conversations: {
        getConversation: (id: string) => (id === 'conv-model' ? conv : undefined),
        findConversationByConversationId: () => undefined,
        persistConversationById: (id: string) => persisted.push(id),
        broadcastConversationUpdate: (id: string) => broadcasts.push(id),
      },
    } as unknown as HandlerContext
    return { ctx, conv, persisted, broadcasts, infoLogs }
  }

  it('updates conversation.model and syncs the snapshot, normalizing a bare alias', () => {
    const { ctx, conv, persisted, broadcasts } = fakeModelCtx({
      model: 'claude-opus-4-8[1m]',
      conversationInfo: { model: 'claude-opus-4-8[1m]' },
    })
    conversationModel(ctx, { conversationId: 'conv-model', model: 'fable' } as unknown as MessageData)
    expect(conv.model).toBe('claude-fable-5')
    expect((conv.conversationInfo as { model: string }).model).toBe('claude-fable-5')
    expect(persisted).toEqual(['conv-model'])
    expect(broadcasts).toEqual(['conv-model'])
  })

  it('falls back to the raw token for an unrecognized model', () => {
    const { ctx, conv } = fakeModelCtx({ model: 'claude-opus-4-8' })
    conversationModel(ctx, { conversationId: 'conv-model', model: 'some-custom-model' } as unknown as MessageData)
    expect(conv.model).toBe('some-custom-model')
  })

  it('no-ops when the resolved model is unchanged (idempotent for duplicate notices)', () => {
    const { ctx, persisted, broadcasts } = fakeModelCtx({ model: 'claude-fable-5' })
    conversationModel(ctx, { conversationId: 'conv-model', model: 'fable' } as unknown as MessageData)
    expect(persisted).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })

  it('ignores an empty or missing model', () => {
    const { ctx, conv, persisted } = fakeModelCtx({ model: 'claude-opus-4-8' })
    conversationModel(ctx, { conversationId: 'conv-model', model: '   ' } as unknown as MessageData)
    conversationModel(ctx, { conversationId: 'conv-model' } as unknown as MessageData)
    expect(conv.model).toBe('claude-opus-4-8')
    expect(persisted).toHaveLength(0)
  })

  it('tolerates a conversation with no prior snapshot (PTY before init)', () => {
    const { ctx, conv } = fakeModelCtx({ model: undefined })
    conversationModel(ctx, { conversationId: 'conv-model', model: 'fable' } as unknown as MessageData)
    expect(conv.model).toBe('claude-fable-5')
    expect(conv.conversationInfo).toBeUndefined()
  })
})
