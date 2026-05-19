import { getProfileFromUri } from '../shared/project-uri'
import type { Conversation, ReviveConversation } from '../shared/protocol'

export interface ReviveOverrides {
  headless?: boolean
  effort?: string
  model?: string
  agent?: string
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
  /** Profile pin -- ALWAYS a literal NAME, never `balanced`/`random`. Revive
   *  never re-rolls. The default comes from the stored projectUri userinfo;
   *  overriding is only useful for tests or recovery flows. */
  profile?: string
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
  // the conversation's projectUri userinfo. Revive never re-rolls balanced /
  // random -- the conversation is permanently bound to the originally-resolved
  // profile (its CC transcripts live under that profile's $CLAUDE_CONFIG_DIR).
  // The `default` profile is implicit and omitted on the wire.
  const profileFromUri = getProfileFromUri(conversation.project)
  const profilePin = overrides?.profile ?? profileFromUri
  return {
    type: 'revive',
    conversationId: newConversationId,
    project: conversation.project,
    ccSessionId: (meta.ccSessionId as string) || conversation.id,
    jobId: overrides?.jobId,
    conversationName: conversation.title || undefined,
    mode: 'resume',
    headless: overrides?.headless ?? lc?.headless,
    effort: overrides?.effort ?? lc?.effort ?? undefined,
    model: overrides?.model ?? lc?.model ?? conversation.model ?? undefined,
    agent: overrides?.agent ?? lc?.agent ?? conversation.agentName ?? undefined,
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
