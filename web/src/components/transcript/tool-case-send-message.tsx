import type { ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import { ChannelBodyCard, DirectionChip, IntentBadge } from './channel-message-parts'
import { ConversationTag } from './conversation-tag'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

// OUTGOING inter-conversation message -- the send_message MCP tool case. This
// is the mirror of the INCOMING card in channel-renderers.tsx; both share the
// direction primitives in channel-message-parts.tsx so the two read as
// opposites at a glance (here: direction "out" -- indigo hue, right edge
// accent, `OUT ▶` chip).
export function renderMcpSendMessage({ input, result }: ToolCaseInput): ToolCaseResult {
  // `to` accepts a single id (string) OR an array of ids (multicast, see the
  // send_message MCP schema). Normalize to a string[] so a multicast call does
  // not pass an array straight into ConversationTag (which would crash on
  // `.toLowerCase()` -- the array survives stripProjectPrefix's `.indexOf`).
  const recipients = (Array.isArray(input.to) ? input.to : [input.to]).filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  const intent = (input.intent as string) || ''
  const msg = (input.message as string) || ''
  // The result only carries a single target_conversation_id; only use it as a
  // resolution fallback when there is exactly one recipient.
  const targetIdMatch = result?.match(/target_conversation_id:\s*([0-9a-f-]{36})/)
  const targetConversationId = recipients.length === 1 ? targetIdMatch?.[1] : undefined
  const summary = (
    <span className="flex items-center gap-1.5 flex-wrap">
      <DirectionChip direction="out" />
      <span className="text-indigo-400/60">to</span>
      {recipients.length > 0 ? (
        recipients.map((r, i) => (
          <span key={r} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-indigo-400/30">·</span>}
            <ConversationTag idOrSlug={r} resolvedId={targetConversationId} />
          </span>
        ))
      ) : (
        <span className="text-muted-foreground/50">(no recipient)</span>
      )}
      <IntentBadge intent={intent} />
    </span>
  )
  let details: ReactNode = null
  if (msg) {
    details = (
      <ChannelBodyCard direction="out" className="py-2">
        <div className="text-sm prose-sm">
          <Markdown copyable>{msg}</Markdown>
        </div>
      </ChannelBodyCard>
    )
  }
  return { summary, details }
}
