import type { Conversation, HookEventOf } from '../../../shared/protocol'
import type { AgentLaunchMeta, ConversationStoreContext } from '../event-context'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Pull the full launch metadata out of an Agent tool_input. Cheap fields
 *  (subagentType/model/description) are split out; everything else beyond the
 *  prompt becomes bulky `args` (isolation, run_in_background, team_name, ...). */
function agentLaunchMetaFrom(input: Record<string, unknown> | undefined): AgentLaunchMeta {
  const { description, subagent_type, model, prompt, ...rest } = input ?? {}
  return {
    description: str(description),
    subagentType: str(subagent_type),
    model: str(model),
    prompt: str(prompt),
    args: Object.keys(rest).length > 0 ? rest : undefined,
  }
}

/**
 * PreToolUse: capture Agent launch metadata (queued for the next SubagentStart)
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
    const queue = ctx.pendingAgentLaunches.get(conversationId) ?? []
    queue.push(agentLaunchMetaFrom(data.tool_input))
    ctx.pendingAgentLaunches.set(conversationId, queue)
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
