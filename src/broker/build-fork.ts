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
 * different profile would look in the wrong directory and find nothing. The
 * worktree pin is the same story one level down: the profile picks the config
 * dir, the worktree picks the project slug inside it, and both have to match
 * the session that was actually recorded.
 */

import { renderForkProvenance } from '../shared/fork-provenance'
import type { Conversation, ForkCcSession, ForkPoint } from '../shared/protocol'

export interface ForkOverrides {
  /** Where the fork will be launched, when that differs from the source. */
  targetWorktree?: string
  targetCwd?: string
  /** Digest cold tool_results over this many tokens. 0 = faithful full copy. */
  digestOverTokens?: number
  /** Keep this many tokens of the most recent turns verbatim. */
  tailTokenBudget?: number
  /** Overrides the conversation's resolved profile (recovery flows only). */
  profile?: string
  /** Fold only one side of a boundary entry. Omitted = fold from HEAD. */
  forkPoint?: ForkPoint
  /**
   * Extra provenance appended below the rendered fork header -- currently the
   * summary of a carry-AFTER cut's discarded history, produced by the broker
   * before the message is built (see fork-dropped-summary.ts).
   */
  extraProvenance?: string
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

  // `digestOverTokens: 0` means nothing was folded -- that is the FULL copy, and
  // telling the agent things were elided when they were not would send it
  // hunting for detail that is already in front of it.
  const mode = overrides?.digestOverTokens === 0 ? 'full' : 'condensed'

  const provenanceBlock = [
    renderForkProvenance({
      conversationId: conversation.id,
      conversationName: conversation.title || conversation.agentName || undefined,
      mode,
    }),
    overrides?.extraProvenance,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    type: 'fork_cc_session',
    requestId,
    project: conversation.project,
    sourceCcSessionId,
    // History, not destination: where the source session ran. Revive has always
    // carried this (build-revive.ts); fork not carrying it meant every
    // worktree-born conversation resolved to the main repo's slug and failed.
    sourceWorktree: conversation.adHocWorktree || undefined,
    provenanceBlock,
    targetWorktree: overrides?.targetWorktree,
    targetCwd: overrides?.targetCwd,
    profile: overrides?.profile ?? conversation.resolvedProfile,
    digestOverTokens: overrides?.digestOverTokens,
    tailTokenBudget: overrides?.tailTokenBudget,
    forkPoint: overrides?.forkPoint,
  }
}
