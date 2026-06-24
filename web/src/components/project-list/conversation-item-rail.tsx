import { memo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { rowSubtitle } from '@/lib/conversation-row'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { ConversationItemShell, ConversationItemTasksBlock } from './conversation-item-helpers'
import { RailMeta, RailTitleRow } from './conversation-item-rail-parts'
import { useConversationRowData } from './row-hooks'

/** Status-rail conversation row (listViewMode:'rail'): leaner than the compact row.
 *  Project identity comes from the group spine (drawn by project-node), so this
 *  leads with the STATE glyph and drops the per-row stripe. Reuses all shared
 *  sub-components + the shared row derivations -- no duplicated logic. */
export const ConversationItemRail = memo(function ConversationItemRail({
  conversation,
}: {
  conversation: Conversation
}) {
  const { isSelected, selectedSubagentId, displayColor, isGhost, ctx, costInfo, cacheInfo } =
    useConversationRowData(conversation)
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const subtitle = rowSubtitle(conversation)

  return (
    <ConversationItemShell
      conversation={conversation}
      isSelected={isSelected}
      displayColor={displayColor}
      ghost={isGhost}
      rail
      onClick={() => {
        haptic('tap')
        selectConversation(conversation.id, 'click')
      }}
    >
      <RailTitleRow conversation={conversation} isSelected={isSelected} isGhost={isGhost} ctx={ctx} />
      {subtitle && (
        <div className="mt-0.5 pl-[18px] text-[9px] text-muted-foreground/70 truncate" title={subtitle}>
          {subtitle}
        </div>
      )}
      {ctx && (
        <div className="mt-0.5 pl-[18px]">
          <div className="h-0.5 bg-muted/50 rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full transition-all', ctx.barColor)} style={{ width: `${ctx.pct}%` }} />
          </div>
        </div>
      )}
      <RailMeta conversation={conversation} cacheInfo={cacheInfo} costInfo={costInfo} />
      <ConversationItemTasksBlock conversation={conversation} selectedSubagentId={selectedSubagentId} />
    </ConversationItemShell>
  )
})
