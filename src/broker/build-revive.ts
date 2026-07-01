import type { Conversation, ReviveConversation } from '../shared/protocol'

export interface ReviveOverrides {
  headless?: boolean
  effort?: string
  model?: string
  agent?: string
  advisor?: string
  bare?: boolean
  repl?: boolean
  permissionMode?: string
  autocompactPct?: number
  maxBudgetUsd?: number
  env?: Record<string, string>
  agentHostType?: string
  openCodeModel?: string
  acpAgent?: string
  toolPermission?: 'none' | 'safe' | 'full'
  /** Profile pin -- ALWAYS a literal NAME. Revive never re-rolls. The default
   *  comes from the conversation's `resolvedProfile` field; overriding is only
   *  useful for tests or recovery flows. */
  profile?: string
  /** FORK: branch a NEW CC session off the source instead of continuing it in
   *  place. The caller pairs this with a fresh `newConversationId`; the source
   *  conversation is left untouched. */
  forkSession?: boolean
  /** FORK / ROLLBACK: truncate replayed history to end at this source message
   *  uuid (`--resume-session-at`). Undefined = fork from HEAD. */
  resumeSessionAt?: string
}

/**
 * Whether a conversation has a resumable CC session (it booted at least once).
 * A FORK replays the source CC session, so callers gate on this before forking.
 * Lives here because `build-revive.ts` is the boundary-allowlisted file allowed
 * to touch `agentHostMeta.ccSessionId` -- the broker core stays free of it and
 * only sees a boolean.
 */
export function conversationHasCcSession(conversation: Conversation): boolean {
  return typeof conversation.agentHostMeta?.ccSessionId === 'string'
}

/**
 * Build a ReviveConversation message from a conversation's full metadata.
 * The broker sends everything it knows; the sentinel picks what it needs.
 * agentHostMeta is passed through opaquely -- broker never interprets it.
 */
export function buildReviveMessage(
  conversation: Conversation,
  newConversationId: string,
  overrides?: ReviveOverrides & { jobId?: string },
): ReviveConversation {
  const lc = conversation.launchConfig
  const meta = conversation.agentHostMeta || {}
  // Sentinel-profile pin: revive ALWAYS forwards the literal NAME stored in
  // `conversation.resolvedProfile`. Revive never re-rolls -- the conversation
  // is permanently bound to the originally-resolved profile (its CC transcripts
  // live under that profile's $CLAUDE_CONFIG_DIR). The `default` profile is
  // implicit and omitted on the wire (stored as undefined).
  const profilePin = overrides?.profile ?? conversation.resolvedProfile
  return {
    type: 'revive',
    conversationId: newConversationId,
    project: conversation.project,
    ccSessionId: (meta.ccSessionId as string) || conversation.id,
    jobId: overrides?.jobId,
    conversationName: conversation.title || undefined,
    mode: 'resume',
    // FORK: branch off the source session (--fork-session) rather than continue
    // it. `resumeSessionAt` truncates the replay to a source message uuid. Both
    // are opaque passthroughs -- the sentinel turns them into CC flags.
    forkSession: overrides?.forkSession || undefined,
    resumeSessionAt: overrides?.resumeSessionAt || undefined,
    headless: overrides?.headless ?? lc?.headless,
    effort: overrides?.effort ?? lc?.effort ?? undefined,
    model: overrides?.model ?? lc?.model ?? conversation.model ?? undefined,
    agent: overrides?.agent ?? lc?.agent ?? conversation.agentName ?? undefined,
    advisor: overrides?.advisor ?? lc?.advisor ?? undefined,
    bare: overrides?.bare ?? lc?.bare ?? undefined,
    repl: overrides?.repl ?? lc?.repl ?? undefined,
    permissionMode: overrides?.permissionMode ?? lc?.permissionMode ?? undefined,
    autocompactPct: overrides?.autocompactPct ?? lc?.autocompactPct ?? conversation.autocompactPct,
    maxBudgetUsd: overrides?.maxBudgetUsd ?? lc?.maxBudgetUsd ?? conversation.maxBudgetUsd,
    adHocWorktree: conversation.adHocWorktree || undefined,
    env: overrides?.env ?? lc?.env ?? undefined,
    // Agent host routing -- must be preserved through revive so the sentinel
    // launches the correct binary (rclaude / opencode-host / acp-host).
    agentHostType: overrides?.agentHostType ?? lc?.agentHostType ?? conversation.agentHostType ?? undefined,
    openCodeModel:
      overrides?.openCodeModel ?? lc?.openCodeModel ?? (meta.openCodeModel as string | undefined) ?? undefined,
    acpAgent: overrides?.acpAgent ?? lc?.acpAgent ?? (meta.acpAgent as string | undefined) ?? undefined,
    toolPermission:
      overrides?.toolPermission ??
      lc?.toolPermission ??
      (meta.openCodeToolPermission as 'none' | 'safe' | 'full' | undefined) ??
      undefined,
    profile: profilePin,
  }
}
