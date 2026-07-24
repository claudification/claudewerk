import { describe, expect, test } from 'bun:test'
import type { Conversation } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { StoredTranscriptRow } from '../recap/shared/transcript-record'
import { readTranscriptTool } from './read-transcript-tool'
import type { DispatchRuntime } from './runtime'
import type { ToolContext } from './tool-def'

const ctx: ToolContext = {}

function row(type: string, content: Record<string, unknown>, ts = 1): StoredTranscriptRow {
  return { type, uuid: `${type}-${ts}-${Math.random()}`, timestamp: ts, content }
}

function userRow(text: string, ts = 1): StoredTranscriptRow {
  return row('user', { message: { role: 'user', content: text } }, ts)
}

function assistantRow(text: string, ts = 1): StoredTranscriptRow {
  return row('assistant', { message: { role: 'assistant', content: [{ type: 'text', text }] } }, ts)
}

function runtime(opts: {
  conversation?: Partial<Conversation> | null
  rows?: StoredTranscriptRow[]
  noTail?: boolean
  onRead?: (conversationId: string, limit: number) => void
}): DispatchRuntime {
  const conv =
    opts.conversation === null
      ? undefined
      : ({ id: 'conv_a', project: 'claude:///p', status: 'ended', ...opts.conversation } as Conversation)
  const rt: DispatchRuntime = {
    store: { getConversation: () => conv } as unknown as ConversationStore,
    callerConversationId: null,
  }
  if (!opts.noTail) {
    rt.readTranscriptTail = (conversationId, limit) => {
      opts.onRead?.(conversationId, limit)
      return opts.rows ?? []
    }
  }
  return rt
}

describe('read_transcript', () => {
  // Offered ALWAYS: it is a voice-contract name, and a missing contract name
  // throws the whole mint. No store degrades to a note, never to an absence.
  test('is still offered when the runtime has no durable transcript store', async () => {
    const tools = readTranscriptTool(runtime({ noTail: true }))
    expect(tools.read_transcript).toBeDefined()
    const out = (await tools.read_transcript.execute({ conversationId: 'conv_a', turns: null }, ctx)) as {
      note: string
    }
    expect(out.note).toContain('no durable transcript store')
  })

  test('reads the tail of an ENDED conversation', async () => {
    const rows = [
      userRow('first question', 1),
      assistantRow('first answer', 2),
      userRow('second question', 3),
      assistantRow('second answer', 4),
    ]
    const tools = readTranscriptTool(runtime({ rows, conversation: { title: 'the arr one', status: 'ended' } }))
    const out = (await tools.read_transcript.execute({ conversationId: 'conv_a', turns: null }, ctx)) as {
      status: string
      title: string
      turns: Array<{ user: string; assistant: string }>
    }
    expect(out.status).toBe('ended')
    expect(out.title).toBe('the arr one')
    expect(out.turns).toEqual([
      { user: 'first question', assistant: 'first answer' },
      { user: 'second question', assistant: 'second answer' },
    ])
  })

  test('keeps the LAST n turns, not the first', async () => {
    const rows = [
      userRow('q1', 1),
      assistantRow('a1', 2),
      userRow('q2', 3),
      assistantRow('a2', 4),
      userRow('q3', 5),
      assistantRow('a3', 6),
    ]
    const tools = readTranscriptTool(runtime({ rows }))
    const out = (await tools.read_transcript.execute({ conversationId: 'conv_a', turns: 2 }, ctx)) as {
      turns: Array<{ user: string }>
    }
    expect(out.turns.map(t => t.user)).toEqual(['q2', 'q3'])
  })

  test('surfaces the END STATE -- the agent`s own last set_status report', async () => {
    const rt = runtime({
      rows: [userRow('go', 1), assistantRow('done', 2)],
      conversation: {
        status: 'ended',
        liveStatus: { state: 'done', done: 'shipped the fix', pending: '', safe_to_close: true, seq: 1, updatedAt: 10 },
      },
    })
    const out = (await readTranscriptTool(rt).read_transcript.execute({ conversationId: 'conv_a', turns: 1 }, ctx)) as {
      reportedStatus: Record<string, unknown>
    }
    expect(out.reportedStatus).toEqual({ state: 'done', done: 'shipped the fix', safeToClose: true })
  })

  test('surfaces the UN-FAKEABLE live signals: waitingFor + lastError', async () => {
    const rt = runtime({
      rows: [userRow('go', 1), assistantRow('working on it', 2)],
      conversation: {
        status: 'active',
        pendingAttention: { type: 'permission', toolName: 'Bash', question: 'run the migration?', timestamp: 5 },
        lastError: { errorType: 'api_error', errorMessage: 'overloaded', timestamp: 3 },
      },
    })
    const out = (await readTranscriptTool(rt).read_transcript.execute({ conversationId: 'conv_a', turns: 1 }, ctx)) as {
      status: string
      waitingFor: Record<string, unknown>
      lastError: Record<string, unknown>
    }
    expect(out.status).toBe('active')
    expect(out.waitingFor).toEqual({ type: 'permission', question: 'run the migration?', toolName: 'Bash' })
    expect(out.lastError).toMatchObject({ type: 'api_error', message: 'overloaded' })
  })

  test('omits the live-signal fields when nothing is pending or broken', async () => {
    const rt = runtime({
      rows: [userRow('go', 1), assistantRow('ok', 2)],
      conversation: { status: 'idle' },
    })
    const out = (await readTranscriptTool(rt).read_transcript.execute({ conversationId: 'conv_a', turns: 1 }, ctx)) as {
      waitingFor?: unknown
      lastError?: unknown
      rateLimit?: unknown
    }
    expect(out.waitingFor).toBeUndefined()
    expect(out.lastError).toBeUndefined()
    expect(out.rateLimit).toBeUndefined()
  })

  test('marks a report the user has since talked over as stale', async () => {
    const rt = runtime({
      rows: [userRow('go', 1), assistantRow('done', 2)],
      conversation: {
        liveStatus: { state: 'done', done: 'shipped', seq: 1, updatedAt: 10 },
        lastInputAt: 99,
      },
    })
    const out = (await readTranscriptTool(rt).read_transcript.execute({ conversationId: 'conv_a', turns: 1 }, ctx)) as {
      reportedStatus: { stale?: string }
    }
    expect(out.reportedStatus.stale).toContain('superseded')
  })

  test('unknown conversation is an error, not an empty read', async () => {
    const tools = readTranscriptTool(runtime({ conversation: null }))
    const out = (await tools.read_transcript.execute({ conversationId: 'conv_nope', turns: null }, ctx)) as {
      error: string
    }
    expect(out.error).toContain('conv_nope')
  })

  test('an empty store answers with a note instead of silence', async () => {
    const tools = readTranscriptTool(runtime({ rows: [] }))
    const out = (await tools.read_transcript.execute({ conversationId: 'conv_a', turns: null }, ctx)) as {
      turns: unknown[]
      note: string
    }
    expect(out.turns).toEqual([])
    expect(out.note).toContain('nothing stored')
  })

  test('tool-traffic-only entries say so rather than returning a bare empty list', async () => {
    const tools = readTranscriptTool(runtime({ rows: [row('system', { subtype: 'hook' }, 1)] }))
    const out = (await tools.read_transcript.execute({ conversationId: 'conv_a', turns: null }, ctx)) as {
      note: string
    }
    expect(out.note).toContain('tool traffic')
  })

  test('caps the turn count and the rows it pulls', async () => {
    let sawLimit = 0
    const tools = readTranscriptTool(
      runtime({
        rows: [],
        onRead: (_id, limit) => {
          sawLimit = limit
        },
      }),
    )
    await tools.read_transcript.execute({ conversationId: 'conv_a', turns: 9999 }, ctx)
    expect(sawLimit).toBe(400)
  })
})
