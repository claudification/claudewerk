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
    expect(resolveSubagentAttribution(ctxWith([]), hook('PreToolUse', { tool_name: 'Read' }))).toBeUndefined()
  })

  it('never tags roster/lifecycle hooks (the broker needs them on the parent)', () => {
    const lifecycle: HookEventType[] = ['SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted']
    for (const h of lifecycle) {
      expect(resolveSubagentAttribution(ctxWith(['a1']), hook(h, { agent_id: 'a1' }))).toBeUndefined()
    }
  })

  it("never tags the parent's own Agent/Task tool hooks", () => {
    expect(resolveSubagentAttribution(ctxWith(['a1']), hook('PreToolUse', { tool_name: 'Agent' }))).toBeUndefined()
    expect(resolveSubagentAttribution(ctxWith(['a1']), hook('PostToolUse', { tool_name: 'Task' }))).toBeUndefined()
  })

  it('tags a subagent tool hook with the running subagent id', () => {
    expect(resolveSubagentAttribution(ctxWith(['a1']), hook('PreToolUse', { tool_name: 'Read' }))).toBe('a1')
  })

  it('tags compaction + SessionStart that fire inside the subagent window (the leak vectors)', () => {
    const vectors: HookEventType[] = ['SessionStart', 'PreCompact', 'PostCompact']
    for (const h of vectors) {
      expect(resolveSubagentAttribution(ctxWith(['a1']), hook(h, { model: 'claude-sonnet-4-6' }))).toBe('a1')
    }
  })

  it('attributes to the most-recently-started subagent when several run concurrently', () => {
    expect(resolveSubagentAttribution(ctxWith(['a1', 'a2', 'a3']), hook('PostToolUse', { tool_name: 'Bash' }))).toBe(
      'a3',
    )
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
    forwardOrQueueHookEvent(ctx, hook('PreToolUse', { tool_name: 'Read' }))
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

  it('queues the already-attributed event when offline, so the flush preserves it', () => {
    const ctx = ctxWith(['a1'], { claudeSessionId: null })
    forwardOrQueueHookEvent(ctx, hook('PostToolUse', { tool_name: 'Grep' }))
    expect(ctx.eventQueue).toHaveLength(1)
    expect(ctx.eventQueue[0].subagentId).toBe('a1')
  })
})
