/**
 * The per-side presentation a real turn resolves before it renders: label, colour,
 * text size, and the badges derived from the group's own entries.
 *
 * Pure derivation, no JSX -- kept out of GroupView so that file stays a renderer.
 */

import type { TranscriptAssistantEntry } from '@/lib/types'
import type { RenderItem, TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'

const SIZE_CLASSES: Record<string, string> = {
  xs: 'text-[8px]',
  sm: 'text-[9px]',
  '': 'text-[10px]',
  lg: 'text-[13px]',
  xl: 'text-[16px]',
}

export interface GroupStyle {
  label: string
  customColor: string
  borderColor: string
  labelBg: string
  sizeClass: string
}

export function groupStyle(isUser: boolean, settings: TranscriptSettings): GroupStyle {
  const { userLabel, agentLabel, userColor, agentColor, userSize, agentSize } = settings
  return {
    label: isUser ? userLabel : agentLabel,
    customColor: isUser ? userColor : agentColor,
    borderColor: isUser ? 'border-event-prompt' : 'border-primary',
    labelBg: isUser ? 'bg-event-prompt text-background' : 'bg-primary text-primary-foreground',
    sizeClass: SIZE_CLASSES[isUser ? userSize : agentSize] || SIZE_CLASSES[''],
  }
}

/**
 * Whether this turn renders as a chat bubble rather than a bordered group.
 *
 * Bubbles are for a plain human message. Anything carrying inter-conversation
 * channel traffic, a dialog, or a project-task card needs the bordered layout --
 * a bubble has no header to hang the badges on and no room for a card.
 */
export function shouldRenderBubble(isUser: boolean, items: RenderItem[], settings: TranscriptSettings): boolean {
  if (!settings.chatBubbles || !isUser) return false
  const hasChannelContent = items.some(
    it => it.kind === 'channel' && (it.isInterConversation || it.isDialog || it.isDialogSubmit || it.isSystem),
  )
  return !hasChannelContent && !items.some(it => it.kind === 'project-task')
}

/** `ultrathink` in a prompt is the user asking for maximum effort; badge it. */
export function effortBadgeFor(isUser: boolean, items: RenderItem[]): { symbol: string; label: string } | null {
  if (!isUser) return null
  return items.some(it => it.kind === 'text' && /\bultrathink\b/i.test(it.text)) ? { symbol: '●', label: 'high' } : null
}

/** The server name when this turn arrived over an inter-conversation channel. */
export function channelServerFor(isUser: boolean, group: DisplayGroup): string | undefined {
  if (!isUser) return undefined
  const origin = (
    group.entries.find(e => (e as unknown as Record<string, unknown>).origin) as unknown as
      | Record<string, unknown>
      | undefined
  )?.origin as { kind: string; server: string } | undefined
  return origin?.kind === 'channel' ? origin.server : undefined
}

/**
 * CC stamps `attributionSkill` on an assistant turn produced by a skill or slash
 * command (e.g. the /insights summary), so the reader knows the turn came from a
 * command rather than free prompting.
 */
export function attributionSkillFor(isUser: boolean, group: DisplayGroup): string | undefined {
  if (isUser) return undefined
  return (
    group.entries.find(e => (e as TranscriptAssistantEntry).attributionSkill) as TranscriptAssistantEntry | undefined
  )?.attributionSkill
}
