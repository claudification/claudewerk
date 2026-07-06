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

describe('processHookEvent subagent window (end-to-end wiring)', () => {
  it('tags hooks between SubagentStart and SubagentStop, and stops tagging after', () => {
    const sent: HookEvent[] = []
    const ctx = makeCtx(sent)

    // Parent spawns a subagent, the subagent reads, then it stops; a parent read
    // follows. Only the in-window read is subagent-attributed.
    processHookEvent(ctx, hook('PreToolUse', { tool_name: 'Agent', tool_input: {} })) // parent spawns
    processHookEvent(ctx, hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }))
    expect(ctx.runningSubagents.has('a1')).toBe(true)
    processHookEvent(ctx, hook('PreToolUse', { tool_name: 'Read', tool_input: {} })) // subagent read
    processHookEvent(ctx, hook('SubagentStop', { agent_id: 'a1' }))
    expect(ctx.runningSubagents.has('a1')).toBe(false)
    processHookEvent(ctx, hook('PreToolUse', { tool_name: 'Read', tool_input: {} })) // parent read

    const byTool = (i: number) => sent[i]
    // [0] parent Agent spawn -- parent (no subagent running yet)
    expect(byTool(0).subagentId).toBeUndefined()
    // [1] SubagentStart -- roster lifecycle, never tagged
    expect(byTool(1).subagentId).toBeUndefined()
    // [2] subagent Read -- tagged with the running subagent
    expect(byTool(2).subagentId).toBe('a1')
    // [3] SubagentStop -- roster lifecycle, never tagged
    expect(byTool(3).subagentId).toBeUndefined()
    // [4] parent Read after the window closed -- untagged
    expect(byTool(4).subagentId).toBeUndefined()

    // Every forwarded event carries the stable parent conversationId.
    for (const e of sent) expect(e.conversationId).toBe('conv_parent')
  })
})
