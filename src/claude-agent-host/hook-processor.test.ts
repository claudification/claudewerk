import { describe, expect, it } from 'bun:test'
import type { HookEvent, HookEventType } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { processHookEvent } from './hook-processor'

/** Context wired just enough to drive the subagent-window branches of
 *  processHookEvent (SubagentStart/Stop tracking + the forward seam). The
 *  fake wsClient captures every forwarded event so the test can inspect the
 *  attribution stamped on the wire. */
function makeCtx(sent: HookEvent[]): AgentHostContext {
  return {
    conversationId: 'conv_parent',
    claudeSessionId: 'cc_sess',
    parentTranscriptPath: null,
    runningSubagents: new Set<string>(),
    eventQueue: [],
    subagentWatchers: new Map(),
    headless: true,
    diag: () => {},
    debug: () => {},
    readTasks: () => {},
    wsClient: {
      isConnected: () => true,
      sendHookEvent: (e: HookEvent) => sent.push(e),
      sendBackgroundActivity: () => {},
    },
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

describe('processHookEvent subagent attribution (end-to-end wiring)', () => {
  // Mirrors a real CC 2.1.209 capture: the parent spawns a BACKGROUND subagent
  // and keeps issuing its own tool hooks while that subagent works. CC stamps
  // agent_id only on the subagent's own hooks, so the two interleave cleanly.
  it('separates interleaved parent and subagent hooks by agent_id', () => {
    const sent: HookEvent[] = []
    const ctx = makeCtx(sent)

    processHookEvent(ctx, hook('PreToolUse', { tool_name: 'Agent', tool_input: {} })) // parent spawns
    processHookEvent(ctx, hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }))
    expect(ctx.runningSubagents.has('a1')).toBe(true)
    // Parent keeps working -- no agent_id (this is what the old window heuristic
    // misattributed to a1).
    processHookEvent(ctx, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo PARENT' } }))
    // The subagent's own tool call -- CC stamps agent_id.
    processHookEvent(ctx, hook('PreToolUse', { tool_name: 'Read', tool_input: {}, agent_id: 'a1' }))
    processHookEvent(ctx, hook('SubagentStop', { agent_id: 'a1' }))
    expect(ctx.runningSubagents.has('a1')).toBe(false)
    processHookEvent(ctx, hook('PreToolUse', { tool_name: 'Read', tool_input: {} })) // parent read

    const byTool = (i: number) => sent[i]
    expect(byTool(0).subagentId).toBeUndefined() // parent Agent spawn
    expect(byTool(1).subagentId).toBeUndefined() // SubagentStart -- roster lifecycle
    expect(byTool(2).subagentId).toBeUndefined() // parent Bash DURING the subagent
    expect(byTool(3).subagentId).toBe('a1') // subagent Read
    expect(byTool(4).subagentId).toBeUndefined() // SubagentStop -- roster lifecycle
    expect(byTool(5).subagentId).toBeUndefined() // parent Read after

    // Every forwarded event carries the stable parent conversationId.
    for (const e of sent) expect(e.conversationId).toBe('conv_parent')
  })
})
