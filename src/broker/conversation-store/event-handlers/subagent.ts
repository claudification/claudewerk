import type { Conversation, HookEventOf } from '../../../shared/protocol'
import type { ConversationStoreContext } from '../event-context'

/**
 * SubagentStart: register a new subagent on the conversation, attaching the
 * pending description (queued by the matching PreToolUse(Agent)) and flip
 * the matching teammate (if any) to 'working'.
 */
export function handleSubagentStart(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEventOf<'SubagentStart'>,
): void {
  const data = event.data
  const agentId = data.agent_id
  if (!agentId) return

  if (!conv.subagents.some(a => a.agentId === agentId)) {
    const queue = ctx.pendingAgentDescriptions.get(conversationId)
    const description = queue?.shift()
    conv.subagents.push({
      agentId,
      agentType: data.agent_type || 'unknown',
      description,
      startedAt: event.timestamp,
      status: 'running',
      events: [],
    })
  }

  // Teammates are agents -- flip the matching teammate row to working
  const teammate = conv.teammates.find(t => t.agentId === agentId)
  if (teammate) {
    teammate.status = 'working'
  }
}

/**
 * SubagentStop: mark the subagent stopped, capture its transcript path if
 * provided, flip the matching teammate row to stopped.
 */
export function handleSubagentStop(conv: Conversation, event: HookEventOf<'SubagentStop'>): void {
  const data = event.data
  const agentId = data.agent_id
  if (!agentId) return

  const agent = conv.subagents.find(a => a.agentId === agentId)
  if (agent) {
    agent.stoppedAt = event.timestamp
    agent.status = 'stopped'
    if (typeof data.agent_transcript_path === 'string') {
      agent.transcriptPath = data.agent_transcript_path
    }
  }

  const teammate = conv.teammates.find(t => t.agentId === agentId)
  if (teammate) {
    teammate.status = 'stopped'
    teammate.stoppedAt = event.timestamp
  }
}
