/**
 * The role glyph on a conversation row.
 *
 * Renders NOTHING for an ordinary conversation. That is deliberate: most rows in
 * the list are ordinary, and a tag on every one of them is a column of noise
 * that makes the three rows you actually care about harder to find, not easier.
 * The glyph earns its space precisely because it is rare.
 */

import { conversationRole, rolePresentation } from '@/lib/conversation-role-ui'
import type { Conversation } from '@/lib/types'
import { cn } from '@/lib/utils'

export function ConversationRoleTag({ conversation, size = 11 }: { conversation: Conversation; size?: number }) {
  const role = conversationRole(conversation)
  const { Icon, label, tint, description } = rolePresentation(role)
  if (!label) return null

  return (
    <span className={cn('inline-flex items-center gap-1 shrink-0', tint)} title={description}>
      <Icon size={size} aria-hidden="true" />
      <span className="text-[9px] font-bold tracking-wider">{label}</span>
    </span>
  )
}
