import { describe, expect, it } from 'bun:test'
import type { HookEvent, HookEventType } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { forwardOrQueueHookEvent, resolveSubagentAttribution } from './hook-forward'

/** Minimal context with only the fields the forwarding seam touches. */
function ctxWith(runningSubagents: string[], over: Partial<AgentHostContext> = {}): AgentHostContext {
  return {
    conversationId: 'conv_parent',
    claudeSessionId: 'cc_sess',
    runningSubagents: new Set(runningSubagents),
    eventQueue: [],
    wsClient: null,
    ...over,
  } as unknown as AgentHostContext
}

function hook(hookEvent: HookEventType, data: Record<string, unknown> = {}): HookEvent {
  return {
    type: 'hook',
    conversationId: 'conv_parent',
    hookEvent,
    timestamp: 1,
    data: { session_id: 'p', ...data },
  } as HookEvent
}

describe('resolveSubagentAttribution', () => {
  it('is parent-originated when no subagent is in flight', () => {
    expect(resolveSubagentAttribution(hook('PreToolUse', { tool_name: 'Read' }))).toBeUndefined()
  })

  it('never tags roster/lifecycle hooks (the broker needs them on the parent)', () => {
    const lifecycle: HookEventType[] = ['SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted']
    for (const h of lifecycle) {
      expect(resolveSubagentAttribution(hook(h, { agent_id: 'a1' }))).toBeUndefined()
    }
  })

  it("never tags the parent's own Agent/Task tool hooks (CC omits agent_id on them)", () => {
    expect(resolveSubagentAttribution(hook('PreToolUse', { tool_name: 'Agent' }))).toBeUndefined()
    expect(resolveSubagentAttribution(hook('PostToolUse', { tool_name: 'Task' }))).toBeUndefined()
  })

  it('tags a subagent tool hook with the agent_id CC stamped on it', () => {
    expect(resolveSubagentAttribution(hook('PreToolUse', { tool_name: 'Read', agent_id: 'a1' }))).toBe('a1')
  })

  it('tags compaction + SessionStart carrying an agent_id (the leak vectors)', () => {
    const vectors: HookEventType[] = ['SessionStart', 'PreCompact', 'PostCompact']
    for (const h of vectors) {
      expect(resolveSubagentAttribution(hook(h, { model: 'claude-sonnet-4-6', agent_id: 'a1' }))).toBe('a1')
    }
  })

  // --- The v2.1.198 regression: subagents run in the BACKGROUND by default, so
  // the parent keeps issuing its own tool hooks while a subagent is in flight.
  // The old running-window heuristic tagged every one of them with the subagent
  // id; measured live on CC 2.1.209, 5-6 parent hooks misattributed per run.
  it('leaves a PARENT tool hook unattributed while a background subagent is in flight', () => {
    // Verbatim from the live capture: parent `echo PARENT_TWO` fires between
    // SubagentStart(a1) and SubagentStop(a1), and carries NO agent_id.
    const parentHook = hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo PARENT_TWO' } })
    expect(resolveSubagentAttribution(parentHook)).toBeUndefined()
  })

  it('interleaves parent and subagent hooks in one window without cross-contamination', () => {
    const parent = hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo PARENT_ONE' } })
    const sub = hook('PreToolUse', { tool_name: 'Bash', agent_id: 'a1', tool_input: { command: 'sleep 25' } })
    expect(resolveSubagentAttribution(parent)).toBeUndefined()
    expect(resolveSubagentAttribution(sub)).toBe('a1')
  })

  it('picks the SPECIFIC sibling by agent_id, not the most-recently-started one', () => {
    // The old heuristic explicitly gave up here and always returned at(-1).
    expect(resolveSubagentAttribution(hook('PostToolUse', { tool_name: 'Bash', agent_id: 'a1' }))).toBe('a1')
    expect(resolveSubagentAttribution(hook('PostToolUse', { tool_name: 'Bash', agent_id: 'a2' }))).toBe('a2')
  })

  it('attributes by agent_id even with an empty roster (no window dependency)', () => {
    // Attribution must not depend on runningSubagents bookkeeping at all --
    // a late-arriving subagent hook after SubagentStop still belongs to it.
    expect(resolveSubagentAttribution(hook('PostToolUse', { tool_name: 'Bash', agent_id: 'a9' }))).toBe('a9')
  })
})

describe('forwardOrQueueHookEvent', () => {
  function fakeWs(sent: HookEvent[]): AgentHostContext['wsClient'] {
    return {
      isConnected: () => true,
      sendHookEvent: (e: HookEvent) => sent.push(e),
    } as unknown as AgentHostContext['wsClient']
  }

  it('stamps subagentId + the stable conversationId on a forwarded subagent hook', () => {
    const sent: HookEvent[] = []
    const ctx = ctxWith(['a1'], { wsClient: fakeWs(sent) })
    forwardOrQueueHookEvent(ctx, hook('PreToolUse', { tool_name: 'Read', agent_id: 'a1' }))
    expect(sent).toHaveLength(1)
    expect(sent[0].conversationId).toBe('conv_parent')
    expect(sent[0].subagentId).toBe('a1')
  })

  it('leaves a parent hook unstamped', () => {
    const sent: HookEvent[] = []
    const ctx = ctxWith([], { wsClient: fakeWs(sent) })
    forwardOrQueueHookEvent(ctx, hook('Stop'))
    expect(sent[0].subagentId).toBeUndefined()
    expect(sent[0].conversationId).toBe('conv_parent')
  })

  it('leaves a parent hook unstamped even while a subagent runs in the background', () => {
    const sent: HookEvent[] = []
    const ctx = ctxWith(['a1'], { wsClient: fakeWs(sent) })
    forwardOrQueueHookEvent(ctx, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo PARENT' } }))
    expect(sent[0].subagentId).toBeUndefined()
  })

  it('queues the already-attributed event when offline, so the flush preserves it', () => {
    const ctx = ctxWith(['a1'], { claudeSessionId: null })
    forwardOrQueueHookEvent(ctx, hook('PostToolUse', { tool_name: 'Grep', agent_id: 'a1' }))
    expect(ctx.eventQueue).toHaveLength(1)
    expect(ctx.eventQueue[0].subagentId).toBe('a1')
  })
})
