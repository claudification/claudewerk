import { randomUUID } from 'node:crypto'
import type { Conversation, HookEventOf, SubagentInfo, TranscriptAgentLaunchEntry } from '../../../shared/protocol'
import type { AgentLaunchMeta, ConversationStoreContext } from '../event-context'
import { persistTranscriptEntries } from '../persist-transcript'

/** Roster card (cheap fields only) for a newly-started inline agent. The big
 *  prompt/args are NOT here -- they go to the sub-stream launch entry. */
function buildSubagentCard(agentId: string, event: HookEventOf<'SubagentStart'>, meta: AgentLaunchMeta): SubagentInfo {
  return {
    agentId,
    agentType: event.data.agent_type || meta.subagentType || 'unknown',
    description: meta.description,
    model: meta.model,
    startedAt: event.timestamp,
    status: 'running',
    events: [],
  }
}

/**
 * Persist the agent sub-stream's head/launch entry (big prompt + bulky args)
 * straight to the store -- durable + FTS-searchable, and NEVER on the broadcast
 * roster card (plan-agent-transcript-separation 3b). No-op when there is nothing
 * big to record. Store-only on purpose: it sidesteps the in-memory cache's
 * isInitial-reset (which would evict a synthesized head entry) and keeps the
 * live subagent seq counter untouched.
 */
function emitAgentLaunchEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  agentId: string,
  meta: AgentLaunchMeta,
  timestamp: number,
): void {
  if (!meta.prompt && !meta.args) return
  const entry: TranscriptAgentLaunchEntry = {
    type: 'agent_launch',
    agentId,
    agentType: meta.subagentType,
    model: meta.model,
    description: meta.description,
    prompt: meta.prompt,
    args: meta.args,
    uuid: randomUUID(),
    timestamp: new Date(timestamp).toISOString(),
  }
  persistTranscriptEntries(ctx.store, ctx.conversations.has(conversationId), conversationId, [entry], agentId)
}

/** Register a new subagent: pop the queued launch metadata, push the cheap
 *  roster card, and route the big prompt/args to the sub-stream launch entry. */
function registerSubagent(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEventOf<'SubagentStart'>,
): void {
  const agentId = event.data.agent_id as string
  const meta = ctx.pendingAgentLaunches.get(conversationId)?.shift() ?? {}
  conv.subagents.push(buildSubagentCard(agentId, event, meta))
  emitAgentLaunchEntry(ctx, conversationId, agentId, meta, event.timestamp)
}

/**
 * SubagentStart: register a new subagent on the conversation (cheap roster card
 * + big launch entry to the sub-stream, see registerSubagent) and flip the
 * matching teammate (if any) to 'working'.
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
    registerSubagent(ctx, conversationId, conv, event)
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
