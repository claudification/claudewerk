import { formatResetIn } from '@shared/format-reset-time'
import { Clock } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import { ModelClassPill } from '@/components/ui/model-class-pill'
import { useConversationsStore } from '@/hooks/use-conversations'
import { rowSubtitle, rowTitle } from '@/lib/conversation-row'
import { formatCost } from '@/lib/cost-utils'
import type { Conversation } from '@/lib/types'
import { cn, formatPermissionMode, haptic } from '@/lib/utils'
import { useIsMobile } from '../input-editor/shell/use-is-mobile'
import { ShareIndicator } from '../share-panel'
import { BackendIcon } from './backend-icon'
import { ConversationInfoButton } from './conversation-info-dialog'
import {
  ConversationAttentionBadges,
  ConversationItemShell,
  ConversationItemTasksBlock,
  DismissButton,
  InlineDescription,
  InlineRename,
  ResultTextModal,
  SpawnedFromSubtext,
} from './conversation-item-helpers'
import { isDaemonTransport } from './conversation-item-internals'
import { GhostAttachButton, GhostBadge, GhostStatusDot } from './ghost-attach'
import { useConversationRowData } from './row-hooks'
import { SentinelProfileBadge } from './sentinel-profile-badge'
import { StatusIndicator } from './status-indicator'

export const ConversationItemCompact = memo(function ConversationItemCompact({
  conversation,
}: {
  conversation: Conversation
}) {
  // Shared subscribe/derive layer (status, ghost, ctx %, cost, cache) -- same
  // source as the status-rail row. Component-specific selectors stay below.
  const { isSelected, selectedSubagentId, displayColor, isGhost, ctx, costInfo, cacheInfo } =
    useConversationRowData(conversation)
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const openTab = useConversationsStore(s => s.openTab)
  const showRecapDesc = useConversationsStore(s => s.controlPanelPrefs.showRecapDescInList)
  const isRenaming = useConversationsStore(s => s.renamingConversationId === conversation.id)
  const isEditingDescription = useConversationsStore(s => s.editingDescriptionConversationId === conversation.id)
  const isMobile = useIsMobile()

  function selectThisConversation() {
    haptic('tap')
    selectConversation(conversation.id, 'click')
  }

  // Compute identity/state values once -- consumed by meta footer (desktop) or
  // subtitle prefix (mobile).
  // Permission-mode badges (B/E/A) intentionally suppressed -- they repeat
  // across most cards and dilute the meta line. Plan mode is the exception:
  // it materially changes behavior and stays visible.
  const permissionBadge =
    conversation.permissionMode === 'plan' ? formatPermissionMode(conversation.permissionMode) : null
  const planModeBadge =
    !permissionBadge && conversation.planMode
      ? { label: 'P', color: 'text-blue-400', title: 'Plan mode -- requires plan approval' }
      : null
  const showHostAlias = conversation.hostSentinelAlias && conversation.hostSentinelAlias !== 'default'

  // Mobile state prefix: small chips/text rendered BEFORE the subtitle.
  // Encoded as renderable nodes so coloring/styling per item is preserved.
  const mobilePrefix: ReactNode[] = []
  if (cacheInfo?.state === 'expired') mobilePrefix.push(<span className="text-red-400/70 font-bold">EXPIRED</span>)
  else if (cacheInfo?.state === 'critical') mobilePrefix.push(<span className="text-red-400 font-bold">CACHE</span>)
  else if (cacheInfo?.state === 'warning') mobilePrefix.push(<span className="text-amber-400 font-bold">CACHE</span>)
  if (permissionBadge)
    mobilePrefix.push(<span className={cn('font-bold', permissionBadge.color)}>{permissionBadge.label}</span>)
  else if (planModeBadge)
    mobilePrefix.push(<span className={cn('font-bold', planModeBadge.color)}>{planModeBadge.label}</span>)
  if (conversation.adHocWorktree) mobilePrefix.push(<span className="text-orange-400 font-bold">WT</span>)
  if (costInfo)
    mobilePrefix.push(
      <span className={cn('font-bold font-mono', costInfo.colorClass)}>
        {formatCost(costInfo.cost, costInfo.exact)}
      </span>,
    )

  return (
    <ConversationItemShell
      conversation={conversation}
      isSelected={isSelected}
      displayColor={displayColor}
      ghost={isGhost}
      onClick={selectThisConversation}
    >
      {/* ── TITLE ROW: status, backend, title, action/attention badges, %, info ─ */}
      <div className="flex items-center gap-1.5">
        {isGhost ? (
          <GhostStatusDot />
        ) : (
          <StatusIndicator status={conversation.status} adHoc={conversation.capabilities?.includes('ad-hoc')} />
        )}
        <BackendIcon backend={conversation.backend} transport={conversation.transport} size={11} />
        {isRenaming ? (
          <div className="flex-1 min-w-0">
            <InlineRename conversation={conversation} />
          </div>
        ) : (
          <span
            className={cn(
              'font-mono text-[11px] font-semibold flex-1 truncate',
              isSelected ? 'text-accent' : 'text-foreground',
            )}
          >
            {rowTitle(conversation, 24)}
          </span>
        )}
        {/* Model class -- identity marker, right of the name in both layouts */}
        {conversation.model && <ModelClassPill model={conversation.model} />}
        {/* Action / attention badges -- always on title row in both layouts */}
        {isGhost && <GhostBadge compact />}
        {isGhost && <GhostAttachButton conversationId={conversation.id} compact />}
        {!isGhost && isDaemonTransport(conversation) && (
          <span className="text-[9px] text-sky-400 font-bold" title="Native claude agents session -- read-only mirror">
            NATIVE
          </span>
        )}
        {conversation.compacting && <span className="text-[9px] text-amber-400 font-bold animate-pulse">COMPACT</span>}
        {conversation.lastError && (
          <span
            className="text-[9px] text-destructive font-bold"
            title={conversation.lastError.errorMessage || conversation.lastError.errorType || 'API error'}
          >
            ERROR
          </span>
        )}
        {conversation.rateLimit && !conversation.lastError && (
          <span
            title={`Rate limited: ${conversation.rateLimit.message}${formatResetIn(conversation.rateLimit.resetsAt) ? ` (${formatResetIn(conversation.rateLimit.resetsAt)})` : ''}`}
          >
            <Clock size={11} className="text-amber-400" />
          </span>
        )}
        <ShareIndicator conversationProject={conversation.project} conversationId={conversation.id} compact />
        <ConversationAttentionBadges conversation={conversation} />
        {/* Context % -- mobile-only on title row (desktop docks it at the bar's right edge) */}
        {isMobile && ctx && (
          <span className={cn('text-[9px] font-mono tabular-nums shrink-0', ctx.color)}>{ctx.pct}%</span>
        )}
        <ConversationInfoButton conversation={conversation} visible={isSelected} />
        {conversation.resultText && conversation.capabilities?.includes('ad-hoc') && (
          <ResultTextModal conversation={conversation} />
        )}
        {conversation.status === 'ended' && <DismissButton conversationId={conversation.id} />}
      </div>
      {conversation.gitBranch && conversation.gitBranch !== 'main' && conversation.gitBranch !== 'master' && (
        <div className="pl-4 flex items-center gap-1">
          <span
            className={cn(
              'text-[9px] font-mono truncate',
              conversation.adHocWorktree ? 'text-orange-400/70' : 'text-purple-400/60',
            )}
          >
            {conversation.adHocWorktree ? '⎇ ' : '⌥ '}
            {conversation.gitBranch}
          </span>
        </div>
      )}
      <SpawnedFromSubtext conversation={conversation} padClass="pl-4" />
      {/* ── SUBTITLE: description / summary / recap (mobile prepends state prefix) ── */}
      {isEditingDescription ? (
        <div className="mt-0.5 pl-4">
          <InlineDescription conversation={conversation} />
        </div>
      ) : (
        (() => {
          const subtitle = rowSubtitle(conversation)
          // Mobile chip prefixes -- profile first (identity), then host alias, then state.
          const mobileChips: ReactNode[] = []
          if (isMobile) {
            mobileChips.push(
              <SentinelProfileBadge
                resolvedProfile={conversation.resolvedProfile}
                hostSentinelAlias={conversation.hostSentinelAlias}
                launchConfig={conversation.launchConfig}
              />,
            )
            if (showHostAlias)
              mobileChips.push(
                <span className="text-muted-foreground/60 font-medium">{conversation.hostSentinelAlias}</span>,
              )
            mobileChips.push(...mobilePrefix)
          }
          if (!subtitle && mobileChips.length === 0) return null
          const baseColor = conversation.description
            ? 'text-muted-foreground/70'
            : conversation.summary
              ? 'text-muted-foreground/50'
              : 'text-zinc-400/80'
          return (
            <div className={cn('mt-0.5 pl-4 text-[9px] truncate flex items-center gap-1', baseColor)} title={subtitle}>
              {mobileChips.map((node, i) => (
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
                <span key={i} className="contents">
                  {i > 0 && <span className="text-muted-foreground/30">·</span>}
                  {node}
                </span>
              ))}
              {subtitle && mobileChips.length > 0 && <span className="text-muted-foreground/30">·</span>}
              {subtitle && <span className="truncate">{subtitle}</span>}
            </div>
          )
        })()
      )}
      {/* Desktop-only: separate summary + recap lines (mobile collapses them into the single subtitle above) */}
      {!isMobile && conversation.description && conversation.summary && (
        <div className="mt-0.5 pl-4 text-[9px] text-muted-foreground/50 truncate" title={conversation.summary}>
          {conversation.summary}
        </div>
      )}
      {!isMobile && (conversation.description || conversation.summary) && conversation.recap?.title && (
        <div className="mt-0.5 pl-4 text-[9px] text-zinc-400/80 truncate">{conversation.recap.title}</div>
      )}
      {/* Recap body (opt-in) -- the long recap description, shown when there's no summary line. */}
      {showRecapDesc && !conversation.summary && conversation.recap && (
        <div
          className={cn(
            'mt-1 pl-4 text-[9px] whitespace-pre-wrap overflow-hidden line-clamp-3 transition-all duration-700',
            conversation.recapFresh
              ? 'text-zinc-300/80 border-l-2 border-zinc-500/50 pl-2 ml-1 py-0.5 bg-zinc-800/20 rounded-r'
              : 'text-muted-foreground/50 italic',
          )}
          title={conversation.recap.content}
        >
          {conversation.recap.content}
        </div>
      )}
      {/* ── DESKTOP ONLY: progress bar + % flexed to the bar's right edge ── */}
      {!isMobile && ctx && (
        <div className="mt-0.5 pl-4 flex items-center gap-1.5">
          <div className="flex-1 h-1 bg-muted/50 rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full transition-all', ctx.barColor)} style={{ width: `${ctx.pct}%` }} />
          </div>
          <span className={cn('text-[9px] font-mono tabular-nums shrink-0', ctx.color)}>{ctx.pct}%</span>
        </div>
      )}
      {/* ── DESKTOP ONLY: meta footer -- profile chip first, then state, dot-separated ── */}
      {!isMobile &&
        (() => {
          const items: ReactNode[] = []
          // Profile pill always leads -- identity over state.
          items.push(
            <SentinelProfileBadge
              key="profile"
              resolvedProfile={conversation.resolvedProfile}
              hostSentinelAlias={conversation.hostSentinelAlias}
              launchConfig={conversation.launchConfig}
            />,
          )
          if (showHostAlias)
            items.push(
              <span key="host" className="px-1 py-0.5 text-[8px] rounded bg-muted text-muted-foreground font-medium">
                {conversation.hostSentinelAlias}
              </span>,
            )
          if (permissionBadge)
            items.push(
              <span key="pm" className={cn('font-bold', permissionBadge.color)} title={permissionBadge.title}>
                {permissionBadge.label}
              </span>,
            )
          else if (planModeBadge)
            items.push(
              <span key="pm" className={cn('font-bold', planModeBadge.color)} title={planModeBadge.title}>
                {planModeBadge.label}
              </span>,
            )
          if (cacheInfo?.state === 'expired')
            items.push(
              <span key="cache" className="text-red-400/70 font-bold">
                EXPIRED
              </span>,
            )
          else if (cacheInfo?.state === 'critical')
            items.push(
              <span key="cache" className="text-red-400 font-bold animate-pulse">
                CACHE
              </span>,
            )
          else if (cacheInfo?.state === 'warning')
            items.push(
              <span key="cache" className="text-amber-400 font-bold">
                CACHE
              </span>,
            )
          if (costInfo)
            items.push(
              <span key="cost" className={cn('font-bold font-mono', costInfo.colorClass)}>
                {formatCost(costInfo.cost, costInfo.exact)}
              </span>,
            )
          if (conversation.adHocWorktree)
            items.push(
              <span key="wt" className="text-orange-400 font-bold">
                WT
              </span>,
            )
          if (items.length === 0) return null
          return (
            <div className="mt-1 pl-4 flex items-center gap-1.5 text-[9px]">
              {items.map((node, i) => (
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
                <span key={i} className="contents">
                  {i > 0 && <span className="text-muted-foreground/30">·</span>}
                  {node}
                </span>
              ))}
            </div>
          )
        })()}
      {/* Cache-expired detail -- idle age + estimated re-cache cost. */}
      {conversation.status === 'idle' &&
        cacheInfo?.state === 'expired' &&
        (() => {
          // react-doctor-disable-next-line react-doctor/rendering-hydration-mismatch-time
          const idleMin = Math.floor((Date.now() - (conversation.lastTurnEndedAt || 0)) / 60_000)
          return (
            <div className="mt-1 pl-4 text-[9px] font-mono text-amber-400/60 truncate">
              cache expired ({idleMin}m idle) -- ~${cacheInfo.reCacheCost.toFixed(2)} re-cache
            </div>
          )
        })()}
      {/* Background tasks + team membership. */}
      {(conversation.runningBgTaskCount > 0 || conversation.team) && (
        <div className="mt-1 pl-4 flex items-center gap-1.5 text-[9px] flex-wrap">
          {conversation.runningBgTaskCount > 0 && (
            // nested inside conversation-row interactive; semantic <button> would be invalid HTML
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            <span
              role="button"
              tabIndex={0}
              className="px-1 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 font-bold cursor-pointer hover:bg-emerald-400/30"
              onClick={e => {
                e.stopPropagation()
                openTab(conversation.id, 'agents')
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  openTab(conversation.id, 'agents')
                }
              }}
            >
              [{conversation.runningBgTaskCount}] bg
            </span>
          )}
          {conversation.team && (
            <span className="px-1 py-0.5 bg-purple-400/20 text-purple-400 border border-purple-400/50 font-bold uppercase">
              {conversation.team.role === 'lead' ? 'LEAD' : 'TEAM'} {conversation.team.teamName}
              {conversation.teammates.length > 0 &&
                ` (${conversation.teammates.filter(t => t.status !== 'stopped').length}/${conversation.teammates.length})`}
            </span>
          )}
        </div>
      )}
      {/* PR links. */}
      {conversation.prLinks && conversation.prLinks.length > 0 && (
        <div className="mt-1 pl-4 flex items-center gap-1.5 flex-wrap">
          {conversation.prLinks.map(pr => (
            <a
              key={pr.prUrl}
              href={pr.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-[9px] font-mono text-sky-400 hover:text-sky-300 transition-colors"
              title={`${pr.prRepository}#${pr.prNumber}`}
            >
              PR#{pr.prNumber}
            </a>
          ))}
        </div>
      )}
      {/* Linked projects. */}
      {conversation.linkedProjects && conversation.linkedProjects.length > 0 && (
        <div className="mt-1 pl-4 text-[9px] text-teal-400/50 font-mono truncate">
          {'↔'} {conversation.linkedProjects.map(p => p.name).join(', ')}
        </div>
      )}
      {/* Linked conversations (the `:` ad-hoc grant -- narrower than project links). */}
      {conversation.linkedConversations && conversation.linkedConversations.length > 0 && (
        <div className="mt-1 pl-4 text-[9px] text-teal-400/50 font-mono truncate">
          {'↔'} {conversation.linkedConversations.map(c => c.name).join(', ')}
        </div>
      )}
      <ConversationItemTasksBlock conversation={conversation} selectedSubagentId={selectedSubagentId} />
    </ConversationItemShell>
  )
})
