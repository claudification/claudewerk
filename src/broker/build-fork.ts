/**
 * Build a ForkCcSession message from a conversation, mirroring build-revive.ts.
 *
 * Like revive, this is one of the few broker files allowed to pull `ccSessionId`
 * out of the opaque `agentHostMeta` bag -- and for the same reason: it HANDS the
 * value to the sentinel without interpreting or branching on it. The web never
 * has to know CC internals; it forks by conversationId.
 *
 * The profile pin matters as much here as on revive. CC writes a transcript
 * under the config dir of the profile that ran it, so a fork resolved against a
 * different profile would look in the wrong directory and find nothing.
 */

import type { Conversation, ForkCcSession } from '../shared/protocol'

export interface ForkOverrides {
  /** Digest cold tool_results over this many tokens. 0 = faithful full copy. */
  digestOverTokens?: number
  /** Keep this many tokens of the most recent turns verbatim. */
  tailTokenBudget?: number
  /** Overrides the conversation's resolved profile (recovery flows only). */
  profile?: string
}

/** Whether a conversation can be forked at all -- i.e. CC ever wrote a transcript for it. */
export function canFork(conversation: Conversation): boolean {
  return typeof conversation.agentHostMeta?.ccSessionId === 'string'
}

export function buildForkMessage(
  conversation: Conversation,
  requestId: string,
  overrides?: ForkOverrides,
): ForkCcSession | null {
  const sourceCcSessionId = conversation.agentHostMeta?.ccSessionId
  // No CC session means nothing to fold. Callers surface this as a disabled
  // menu item rather than a failed request.
  if (typeof sourceCcSessionId !== 'string' || !sourceCcSessionId) return null

  return {
    type: 'fork_cc_session',
    requestId,
    project: conversation.project,
    sourceCcSessionId,
    profile: overrides?.profile ?? conversation.resolvedProfile,
    digestOverTokens: overrides?.digestOverTokens,
    tailTokenBudget: overrides?.tailTokenBudget,
  }
}
