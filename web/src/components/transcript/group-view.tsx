import { memo } from 'react'
import { cn } from '@/lib/utils'
import { ChatBubble } from './chat-bubble'
import { ForkPointMenu } from './fork-point-menu'
import { buildForkPointSeed } from './fork-point-seed'
import { renderChromeGroup } from './group-chrome'
import { GroupHeader } from './group-header'
import { GroupItem } from './group-item'
import { attributionSkillFor, channelServerFor, effortBadgeFor, groupStyle, shouldRenderBubble } from './group-style'
import type { ResultLookup, TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'
import { parseGroupEntries } from './parse-entries'

export { CompactedDivider, CompactingBanner } from './compacted-divider'
export { BUBBLE_COLOR_OPTIONS } from './group-view-types'
export { SkillDivider } from './skill-divider'

function GroupView({
  group,
  getResult,
  settings,
  showThinking = false,
  planContext,
  // When true (virtualized renderer) a continuation group pulls ITSELF up via a
  // negative top margin on this inner box. The plain renderer sets this false and
  // applies the same tuck on its OUTER .transcript-plain-group wrapper instead:
  // that wrapper has content-visibility (contain:paint), which would CLIP a child
  // pulled above the box top (the "cut text on new layout" bug). Moving the tuck
  // to the contained box itself moves the whole box, so nothing is clipped.
  continuationOffset = true,
}: {
  group: DisplayGroup
  getResult: ResultLookup
  settings: TranscriptSettings
  showThinking?: boolean
  planContext?: { content: string; path?: string }
  continuationOffset?: boolean
}) {
  const ts = group.timestamp

  const chrome = renderChromeGroup(group, ts)
  if (chrome) return <>{chrome}</>

  const isUser = group.type === 'user'
  const items = parseGroupEntries(group.entries, getResult)

  const effortBadge = effortBadgeFor(isUser, items)
  const channelServer = channelServerFor(isUser, group)
  const attributionSkill = attributionSkillFor(isUser, group)
  const { label, customColor, borderColor, labelBg, sizeClass } = groupStyle(isUser, settings)
  const { expandAll, bubbleColor } = settings

  // Built once per group and handed to BOTH render paths -- a right-click has to
  // mean the same thing on a bubble as on a bordered group.
  const forkSeed = buildForkPointSeed(group, items)

  if (shouldRenderBubble(isUser, items, settings)) {
    return (
      <ForkPointMenu seed={forkSeed}>
        <ChatBubble
          items={items}
          ts={ts}
          bubbleColor={bubbleColor}
          sizeClass={sizeClass}
          queued={group.queued}
          channelServer={channelServer}
          effortBadge={effortBadge}
        />
      </ForkPointMenu>
    )
  }

  return (
    <ForkPointMenu seed={forkSeed}>
      <div
        className={cn(
          'mb-4',
          // A seq-bucket continuation renders headerless and pulls itself up so
          // the inter-group gap (mb-4 - mt-2 = 8px) matches the intra-group
          // space-y-2 -- the split is invisible to the reader. Suppressed when the
          // wrapper owns the tuck (plain renderer -- see continuationOffset above).
          group.continuation && continuationOffset && '-mt-2',
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
    </ForkPointMenu>
  )
}

export const MemoizedGroupView = memo(GroupView)
