import type { ReactNode } from 'react'
import { ModelClassPill } from '@/components/ui/model-class-pill'
import { errorTitle, formatCostInfo, rowTitle } from '@/lib/conversation-row'
import type { Conversation } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BackendIcon } from './backend-icon'
import { BranchPill } from './branch-pill'
import { ConversationAttentionBadges, DismissButton, InterpunctRow } from './conversation-item-helpers'
import { GhostAttachButton, GhostBadge, GhostStatusDot } from './ghost-attach'
import type { useConversationRowData } from './row-hooks'
import { SentinelProfileBadge } from './sentinel-profile-badge'
import { StatusIndicator } from './status-indicator'

type RowData = ReturnType<typeof useConversationRowData>

/** Leading zone of the rail title: state glyph (or ghost dot) + backend icon. */
function RailLead({ conversation, isGhost }: { conversation: Conversation; isGhost: boolean }) {
  return (
    <>
      {isGhost ? (
        <GhostStatusDot />
      ) : (
        <StatusIndicator status={conversation.status} adHoc={conversation.capabilities?.includes('ad-hoc')} />
      )}
      <BackendIcon backend={conversation.backend} transport={conversation.transport} size={11} />
    </>
  )
}

/** Ghost-worker badges (attach prompt) -- only present for discovered daemon workers. */
function RailGhostBadges({ conversation, isGhost }: { conversation: Conversation; isGhost: boolean }) {
  if (!isGhost) return null
  return (
    <>
      <GhostBadge compact />
      <GhostAttachButton conversationId={conversation.id} compact />
    </>
  )
}

/** Trailing status flags: compacting, last-error, and the dismiss control on ended rows. */
function RailFlags({ conversation }: { conversation: Conversation }) {
  return (
    <>
      {conversation.compacting && <span className="text-[9px] text-amber-400 font-bold animate-pulse">COMPACT</span>}
      {conversation.lastError && (
        <span className="text-[9px] text-destructive font-bold" title={errorTitle(conversation)}>
          ERROR
        </span>
      )}
      {conversation.status === 'ended' && <DismissButton conversationId={conversation.id} />}
    </>
  )
}

/** Title row of the status-rail row: lead glyph, name, model, attention badges, context %.
 *  Split into zone components (lead / ghost / flags) so each stays simple. */
export function RailTitleRow({
  conversation,
  isSelected,
  isGhost,
  ctx,
}: {
  conversation: Conversation
  isSelected: boolean
  isGhost: boolean
  ctx: RowData['ctx']
}) {
  return (
    <div className="flex items-center gap-1.5">
      <RailLead conversation={conversation} isGhost={isGhost} />
      <span
        className={cn(
          'font-mono text-[11px] font-semibold flex-1 truncate',
          isSelected ? 'text-accent' : 'text-foreground',
        )}
      >
        {rowTitle(conversation)}
      </span>
      {conversation.model && <ModelClassPill model={conversation.model} />}
      <RailGhostBadges conversation={conversation} isGhost={isGhost} />
      <ConversationAttentionBadges conversation={conversation} />
      {ctx && <span className={cn('text-[9px] font-mono tabular-nums shrink-0', ctx.color)}>{ctx.pct}%</span>}
      <RailFlags conversation={conversation} />
    </div>
  )
}

/** Meta footer of the status-rail row: profile chip, then EXPIRED + cost, dot-separated. */
export function RailMeta({
  conversation,
  cacheInfo,
  costInfo,
}: {
  conversation: Conversation
  cacheInfo: RowData['cacheInfo']
  costInfo: RowData['costInfo']
}) {
  // Declarative chip list -- InterpunctRow drops the falsy slots + dot-joins the
  // rest, so no per-chip `if` branches live here (keeps this builder trivial).
  const items: ReactNode[] = [
    <SentinelProfileBadge
      key="profile"
      resolvedProfile={conversation.resolvedProfile}
      hostSentinelAlias={conversation.hostSentinelAlias}
      launchConfig={conversation.launchConfig}
    />,
    cacheInfo?.state === 'expired' ? (
      <span key="cache" className="text-red-400/70 font-bold">
        EXPIRED
      </span>
    ) : null,
    costInfo ? (
      <span key="cost" className={cn('font-bold font-mono', costInfo.colorClass)}>
        {formatCostInfo(costInfo)}
      </span>
    ) : null,
    <BranchPill key="branch" conversation={conversation} compact />,
  ]
  return (
    <div className="mt-0.5 pl-[18px] flex items-center gap-1.5 text-[9px]">
      <InterpunctRow items={items} />
    </div>
  )
}
