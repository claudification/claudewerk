import { describe, expect, test } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { type HandlerContext, handleMessage } from './stream-handlers'
import { createReplayBuffer } from './stream-replay'

function createTestContext(extraCallbacks: Partial<HandlerContext['callbacks']> = {}): {
  hctx: HandlerContext
  entries: TranscriptEntry[]
} {
  const entries: TranscriptEntry[] = []
  const hctx: HandlerContext = {
    monitors: { pendingMonitorInputs: new Map(), agentToolUseToTask: new Map(), monitorTasks: new Map() },
    replay: createReplayBuffer(),
    pendingControlRequests: new Map(),
    callbacks: {
      onTranscriptEntries(e) {
        entries.push(...e)
      },
      ...extraCallbacks,
    },
  }
  hctx.replay.done = true
  return { hctx, entries }
}

describe('stream-handlers UUID synthesis', () => {
  test('tool_result user message without UUID gets deterministic UUID', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok' }] },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBeDefined()
    expect(entries[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('tool_result user message with UUID from CC preserves it', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      uuid: 'cc-provided-uuid-1234',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'yes' }] },
    })
    expect(entries[0].uuid).toBe('cc-provided-uuid-1234')
  })

  test('same tool_result user message always produces same UUID', () => {
    const { hctx: hctx1, entries: entries1 } = createTestContext()
    const { hctx: hctx2, entries: entries2 } = createTestContext()
    const msg = {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_3', type: 'tool_result', content: 'same' }] },
    }
    handleMessage(hctx1, { ...msg })
    handleMessage(hctx2, { ...msg })
    expect(entries1[0].uuid).toBe(entries2[0].uuid)
  })

  test('different tool_result messages produce different UUIDs', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_A', type: 'tool_result', content: 'a' }] },
    })
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:26.000Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_B', type: 'tool_result', content: 'b' }] },
    })
    expect(entries[0].uuid).not.toBe(entries[1].uuid)
  })

  test('plain text user message gets deterministic UUID', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: 'hello world' },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('same plain text user message always produces same UUID (dedup-safe)', () => {
    const { hctx: hctx1, entries: entries1 } = createTestContext()
    const { hctx: hctx2, entries: entries2 } = createTestContext()
    const msg = {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: 'hello world' },
    }
    handleMessage(hctx1, { ...msg })
    handleMessage(hctx2, { ...msg })
    expect(entries1[0].uuid).toBe(entries2[0].uuid)
  })

  test('assistant message without UUID gets deterministic UUID', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'assistant',
      timestamp: '2026-05-08T15:17:32.164Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBeDefined()
    expect(entries[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('CC echo reuses stashed UUID from synthetic (dedup with broker)', () => {
    const stash = new Map<string, string>()
    const entries: TranscriptEntry[] = []
    const hctx: HandlerContext = {
      monitors: { pendingMonitorInputs: new Map(), agentToolUseToTask: new Map(), monitorTasks: new Map() },
      replay: createReplayBuffer(),
      pendingControlRequests: new Map(),
      syntheticUserUuids: stash,
      conversationId: 'test-conv-id',
      callbacks: {
        onTranscriptEntries(e) {
          entries.push(...e)
        },
      },
    }
    hctx.replay.done = true

    // Simulate sendUserMessage stashing a UUID
    const { createHash } = require('node:crypto')
    const content = 'hello world'
    const contentHash = createHash('sha1').update(content).digest('hex').slice(0, 16)
    stash.set(contentHash, 'stashed-uuid-12345')

    // CC echo arrives -- should reuse the stashed UUID
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:17:40.000Z',
      message: { role: 'user', content },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBe('stashed-uuid-12345')
    expect(stash.size).toBe(0) // consumed
  })

  test('assistant message with UUID from CC preserves it', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'assistant',
      uuid: 'cc-assistant-uuid',
      timestamp: '2026-05-08T15:17:32.164Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(entries[0].uuid).toBe('cc-assistant-uuid')
  })

  test('plain text user message during replay goes to buffer', () => {
    const { hctx, entries } = createTestContext()
    hctx.replay.done = false
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      isReplay: true,
      message: { role: 'user', content: 'hello world' },
    })
    expect(entries).toHaveLength(0)
    expect(hctx.replay.entries).toHaveLength(1)
  })

  test('tool_result user and assistant with same timestamp produce different UUIDs', () => {
    const { hctx, entries } = createTestContext()
    const ts = '2026-05-08T15:15:25.731Z'
    handleMessage(hctx, {
      type: 'user',
      timestamp: ts,
      message: { role: 'user', content: [{ tool_use_id: 'toolu_x', type: 'tool_result', content: 'same' }] },
    })
    handleMessage(hctx, { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: 'same' } })
    expect(entries).toHaveLength(2)
    expect(entries[0].uuid).not.toBe(entries[1].uuid)
  })
})

describe('stream-handlers subagent containment (Checkpoint A)', () => {
  function createContainmentCtx() {
    const parent: TranscriptEntry[] = []
    const subagent: Array<{ agentId: string; entry: TranscriptEntry }> = []
    const monitorUpdates: Array<{ taskId: string; status: string }> = []
    const hctx: HandlerContext = {
      monitors: { pendingMonitorInputs: new Map(), agentToolUseToTask: new Map(), monitorTasks: new Map() },
      replay: createReplayBuffer(),
      pendingControlRequests: new Map(),
      callbacks: {
        onTranscriptEntries(e) {
          parent.push(...e)
        },
        onSubagentEntry(agentId, entry) {
          subagent.push({ agentId, entry })
        },
        onMonitorUpdate(m) {
          monitorUpdates.push({ taskId: m.taskId, status: m.status })
        },
      },
    }
    hctx.replay.done = true
    return { hctx, parent, subagent, monitorUpdates }
  }

  function startAgent(hctx: HandlerContext, taskId: string, toolUseId: string) {
    handleMessage(hctx, {
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_agent',
      task_id: taskId,
      tool_use_id: toolUseId,
    })
  }

  function startMonitor(hctx: HandlerContext, taskId: string, toolUseId: string) {
    handleMessage(hctx, {
      type: 'system',
      subtype: 'task_started',
      task_type: 'bash',
      task_id: taskId,
      tool_use_id: toolUseId,
    })
  }

  test('task_progress with an EMPTY agent map is agent-scoped, never the parent (52b5f3ec leak)', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    // No task_started ran -> maps empty (post-reconnect / revival).
    handleMessage(hctx, { type: 'system', subtype: 'task_progress', task_id: 'task_x', usage: { total_tokens: 5 } })
    expect(parent).toHaveLength(0)
    expect(subagent).toHaveLength(1)
    expect(subagent[0].agentId).toBe('task_x') // keyed by task_id fallback, no drop
  })

  test('N task_progress entries with an empty map all divert -- parent stays clean', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    for (let i = 0; i < 48; i++) {
      handleMessage(hctx, { type: 'system', subtype: 'task_progress', task_id: 'task_y', usage: { total_tokens: i } })
    }
    expect(parent).toHaveLength(0)
    expect(subagent).toHaveLength(48)
    expect(subagent.every(s => s.agentId === 'task_y')).toBe(true)
  })

  test('task_notification (non-monitor) is agent-scoped, not parent', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    handleMessage(hctx, { type: 'system', subtype: 'task_notification', task_id: 'task_z', status: 'running' })
    expect(parent).toHaveLength(0)
    expect(subagent).toHaveLength(1)
    expect(subagent[0].agentId).toBe('task_z')
  })

  test('monitor task_progress stays in the parent stream (NOT diverted)', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    startMonitor(hctx, 'mon_1', 'toolu_m')
    handleMessage(hctx, { type: 'system', subtype: 'task_progress', task_id: 'mon_1', usage: { total_tokens: 3 } })
    expect(subagent).toHaveLength(0)
    expect(parent).toHaveLength(1)
    expect((parent[0] as { subtype?: string }).subtype).toBe('task_progress')
  })

  test('monitor task_notification stays in the parent + fires monitor update', () => {
    const { hctx, parent, subagent, monitorUpdates } = createContainmentCtx()
    startMonitor(hctx, 'mon_2', 'toolu_m2')
    handleMessage(hctx, { type: 'system', subtype: 'task_notification', task_id: 'mon_2', status: 'completed' })
    expect(subagent).toHaveLength(0)
    expect(parent).toHaveLength(1)
    // task_started emits a 'running' update; the notification adds 'completed'.
    expect(monitorUpdates.at(-1)).toEqual({ taskId: 'mon_2', status: 'completed' })
  })

  test('assistant subagent entry resolves to the task id scope when task_started ran', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    startAgent(hctx, 'task_1', 'toolu_1')
    handleMessage(hctx, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      timestamp: '2026-05-29T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi from agent' }] },
    })
    expect(parent).toHaveLength(0)
    expect(subagent).toHaveLength(1)
    expect(subagent[0].agentId).toBe('task_1') // resolved tool_use -> task id
  })

  test('assistant subagent entry falls back to the tool_use id when the map is empty (no drop, no leak)', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    handleMessage(hctx, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_orphan',
      timestamp: '2026-05-29T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'orphan agent' }] },
    })
    expect(parent).toHaveLength(0)
    expect(subagent).toHaveLength(1)
    expect(subagent[0].agentId).toBe('toolu_orphan')
  })

  test('a plain main-agent assistant entry (no parent_tool_use_id) still goes to the parent', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    handleMessage(hctx, {
      type: 'assistant',
      timestamp: '2026-05-29T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'main reply' }] },
    })
    expect(subagent).toHaveLength(0)
    expect(parent).toHaveLength(1)
  })

  test('system entry carrying parent_tool_use_id resolves to the agent scope', () => {
    const { hctx, parent, subagent } = createContainmentCtx()
    startAgent(hctx, 'task_2', 'toolu_2')
    handleMessage(hctx, {
      type: 'system',
      subtype: 'informational',
      parent_tool_use_id: 'toolu_2',
      content: 'agent note',
    })
    expect(parent).toHaveLength(0)
    expect(subagent).toHaveLength(1)
    expect(subagent[0].agentId).toBe('task_2')
  })
})

describe('stream-handlers thinking_tokens', () => {
  function createThinkingProgressCtx() {
    const progress: Array<{ tokens: number; delta?: number }> = []
    const ctx = createTestContext({ onThinkingProgress: s => progress.push(s) })
    return { ...ctx, progress }
  }

  test('system/thinking_tokens fires onThinkingProgress and does NOT persist a transcript entry', () => {
    const { hctx, entries, progress } = createThinkingProgressCtx()

    handleMessage(hctx, {
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 150,
      estimated_tokens_delta: 100,
    })

    expect(entries).toHaveLength(0)
    expect(progress).toEqual([{ tokens: 150, delta: 100 }])
  })

  test('first thinking_tokens ping (no delta field) yields undefined delta', () => {
    const { hctx, progress } = createThinkingProgressCtx()

    handleMessage(hctx, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 })

    expect(progress).toEqual([{ tokens: 50, delta: undefined }])
  })
})

describe('stream-handlers commands_changed', () => {
  function createCommandsChangedCtx() {
    const catalogs: string[][] = []
    const ctx = createTestContext({ onCommandsChanged: names => catalogs.push(names) })
    return { ...ctx, catalogs }
  }

  test('system/commands_changed forwards the command names and does NOT persist a transcript entry', () => {
    const { hctx, entries, catalogs } = createCommandsChangedCtx()

    handleMessage(hctx, {
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'clear', description: 'Start a new session', argumentHint: '[name]' },
        { name: 'compact', description: 'Free up context' },
      ],
    })

    expect(entries).toHaveLength(0)
    expect(catalogs).toEqual([['clear', 'compact']])
  })

  test('commands_changed tolerates a missing/garbled commands array', () => {
    const { hctx, entries, catalogs } = createCommandsChangedCtx()

    handleMessage(hctx, { type: 'system', subtype: 'commands_changed' })
    handleMessage(hctx, { type: 'system', subtype: 'commands_changed', commands: [{ noName: true }, 'bogus'] })

    expect(entries).toHaveLength(0)
    expect(catalogs).toEqual([[], []])
  })
})

describe('advisor tool events', () => {
  test('advisor_result folds into a dedicated advisor entry with text + model', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'system',
      subtype: 'advisor_result',
      timestamp: '2026-06-10T12:00:00.000Z',
      advisor_model: 'claude-fable-5',
      content: { text: 'Your plan looks sound; verify the edge case in step 3.' },
    })
    expect(entries).toHaveLength(1)
    const e = entries[0] as Extract<TranscriptEntry, { type: 'advisor' }>
    expect(e.type).toBe('advisor')
    expect(e.advisorSubtype).toBe('result')
    expect(e.advisorModel).toBe('claude-fable-5')
    expect(e.text).toBe('Your plan looks sound; verify the edge case in step 3.')
    expect(e.raw).toBeDefined()
  })

  test('advisor_redacted_result flags redacted; advisor_tool_result_error flags error', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, { type: 'system', subtype: 'advisor_redacted_result', content: { text: '' } })
    handleMessage(hctx, { type: 'system', subtype: 'advisor_tool_result_error', text: 'boom' })
    const redacted = entries[0] as Extract<TranscriptEntry, { type: 'advisor' }>
    const errored = entries[1] as Extract<TranscriptEntry, { type: 'advisor' }>
    expect(redacted.redacted).toBe(true)
    expect(errored.isError).toBe(true)
    expect(errored.text).toBe('boom')
  })

  test('advisor_message with a string content still extracts text', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, { type: 'system', subtype: 'advisor_message', content: 'thinking it over' })
    const e = entries[0] as Extract<TranscriptEntry, { type: 'advisor' }>
    expect(e.advisorSubtype).toBe('message')
    expect(e.text).toBe('thinking it over')
  })
})
