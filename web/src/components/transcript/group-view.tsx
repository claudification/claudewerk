import { memo } from 'react'
import type { TranscriptAssistantEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AdvisorCard } from './advisor-card'
import { BootTimeline } from './boot-timeline'
import { ChatBubble } from './chat-bubble'
import { GroupHeader } from './group-header'
import { GroupItem } from './group-item'
import type { ResultLookup, TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'
import { LaunchTimeline } from './launch-timeline'
import { parseGroupEntries } from './parse-entries'
import { ShellReceipt } from './shell-receipt'
import { SpawnNotification } from './spawn-notification'
import { SystemLine } from './system-line'
import { TaskNotificationLine } from './task-notification-line'

export { CompactedDivider, CompactingBanner } from './compacted-divider'
export { BUBBLE_COLOR_OPTIONS } from './group-view-types'
export { SkillDivider } from './skill-divider'

function GroupView({
  group,
  getResult,
  settings,
  showThinking = false,
  planContext,
}: {
  group: DisplayGroup
  getResult: ResultLookup
  settings: TranscriptSettings
  showThinking?: boolean
  planContext?: { content: string; path?: string }
}) {
  const { expandAll, userLabel, agentLabel, userColor, agentColor, userSize, agentSize } = settings
  const ts = group.timestamp

  if (group.type === 'boot') {
    return <BootTimeline group={group} />
  }

  if (group.type === 'launch') {
    return <LaunchTimeline group={group} />
  }

  if (group.type === 'spawn_notification') {
    return <SpawnNotification group={group} />
  }

  if (group.type === 'shell') {
    return <ShellReceipt group={group} />
  }

  if (group.type === 'advisor') {
    return <AdvisorCard group={group} />
  }

  if (group.type === 'system' && group.notifications?.length) {
    return (
      <div className="mb-2 space-y-1">
        {group.notifications.map((n, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
          // biome-ignore lint/suspicious/noArrayIndexKey: notifications are ordered display items, no stable IDs
          <TaskNotificationLine key={i} notification={n} ts={ts} />
        ))}
      </div>
    )
  }

  if (group.type === 'system' && group.systemSubtype) {
    return <SystemLine group={group} ts={ts} />
  }

  const isUser = group.type === 'user'
  const items = parseGroupEntries(group.entries, getResult)

  const effortBadge =
    isUser && items.some(it => it.kind === 'text' && /\bultrathink\b/i.test(it.text))
      ? { symbol: '●', label: 'high' }
      : null

  const channelOrigin = isUser
    ? ((group.entries.find(e => (e as unknown as Record<string, unknown>).origin) as unknown as Record<string, unknown>)
        ?.origin as { kind: string; server: string } | undefined)
    : undefined
  const channelServer = channelOrigin?.kind === 'channel' ? channelOrigin.server : undefined

  // CC stamps `attributionSkill` on an assistant turn produced by a skill or
  // slash command (e.g. the /insights summary). Surface it as a "via /name"
  // badge so the reader knows the turn came from a command, not free prompting.
  const attributionSkill = isUser
    ? undefined
    : (
        group.entries.find(e => (e as TranscriptAssistantEntry).attributionSkill) as
          | TranscriptAssistantEntry
          | undefined
      )?.attributionSkill

  const label = isUser ? userLabel : agentLabel
  const customColor = isUser ? userColor : agentColor
  const borderColor = isUser ? 'border-event-prompt' : 'border-primary'
  const labelBg = isUser ? 'bg-event-prompt text-background' : 'bg-primary text-primary-foreground'
  const sizeKey = isUser ? userSize : agentSize
  const sizeClass =
    { xs: 'text-[8px]', sm: 'text-[9px]', '': 'text-[10px]', lg: 'text-[13px]', xl: 'text-[16px]' }[sizeKey] ||
    'text-[10px]'
  const { chatBubbles, bubbleColor } = settings

  const hasInterConversationContent = items.some(
    it => it.kind === 'channel' && (it.isInterConversation || it.isDialog || it.isDialogSubmit || it.isSystem),
  )
  const hasProjectTask = items.some(it => it.kind === 'project-task')

  if (chatBubbles && isUser && !hasInterConversationContent && !hasProjectTask) {
    return (
      <ChatBubble
        items={items}
        ts={ts}
        bubbleColor={bubbleColor}
        sizeClass={sizeClass}
        queued={group.queued}
        channelServer={channelServer}
        effortBadge={effortBadge}
      />
    )
  }

  return (
    <div
      className={cn(
        'mb-4',
        // A seq-bucket continuation renders headerless and pulls itself up so
        // the inter-group gap (mb-4 - mt-2 = 8px) matches the intra-group
        // space-y-2 -- the split is invisible to the reader.
        group.continuation && '-mt-2',
        group.planMode && 'border-l-2 border-blue-500/30 pl-2 bg-blue-950/10 rounded-r',
      )}
    >
      {!group.continuation && (
        <GroupHeader
          label={label}
          customColor={customColor}
          borderColor={borderColor}
          labelBg={labelBg}
          sizeClass={sizeClass}
          channelServer={channelServer}
          effortBadge={effortBadge}
          attributionSkill={attributionSkill}
          queued={group.queued}
          ts={ts}
        />
      )}
      <div className={cn('pl-4 space-y-2', group.queued && 'opacity-50')}>
        {items.map((item, i) => (
          <GroupItem
            // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
            // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
            key={i}
            item={item}
            showThinking={showThinking}
            expandAll={expandAll}
            planContext={planContext}
          />
        ))}
      </div>
    </div>
  )
}

export const MemoizedGroupView = memo(GroupView)
