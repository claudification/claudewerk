import type { Conversation, HookEventOf } from '../../../shared/protocol'
import type { ConversationStoreContext } from '../event-context'

/**
 * PreToolUse: capture Agent description (queued for the next SubagentStart)
 * and flip pendingAttention when AskUserQuestion fires (Claude is blocked
 * waiting on a structured answer).
 */
export function handlePreToolUse(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEventOf<'PreToolUse'>,
): void {
  const data = event.data

  if (data.tool_name === 'Agent') {
    const description = data.tool_input?.description
    if (typeof description === 'string') {
      const queue = ctx.pendingAgentDescriptions.get(conversationId) ?? []
      queue.push(description)
      ctx.pendingAgentDescriptions.set(conversationId, queue)
    }
  }

  if (data.tool_name === 'AskUserQuestion') {
    const question = data.tool_input?.question
    conv.pendingAttention = {
      type: 'ask',
      toolName: 'AskUserQuestion',
      question: typeof question === 'string' ? question : undefined,
      timestamp: event.timestamp,
    }
  }
}
