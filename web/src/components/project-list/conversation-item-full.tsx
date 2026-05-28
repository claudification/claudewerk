import { formatResetIn } from '@shared/format-reset-time'
import { projectIdentityKey } from '@shared/project-uri'
import { Clock } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useGhostShort } from '@/hooks/use-ghost-sessions'
import { formatCost, getCacheTimerInfo, getConversationCost, getCostBgColor, getCostLevel } from '@/lib/cost-utils'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, contextWindowSize, haptic, projectDisplayName } from '@/lib/utils'
import { renderProjectIcon } from '../project-icons'
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
import { SentinelProfileBadge } from './sentinel-profile-badge'
import { StatusIndicator } from './status-indicator'

export const ConversationItemFull = memo(function ConversationItemFull({
  conversation,
}: {
  conversation: Conversation
}) {
  const isSelected = useConversationsStore(s => s.selectedConversationId === conversation.id)
  const selectedSubagentId = useConversationsStore(s =>
    s.selectedConversationId === conversation.id ? s.selectedSubagentId : null,
  )
  const selectConversation = useConversationsStore(s => s.selectConversation)

  const openTab = useConversationsStore(s => s.openTab)
  const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(conversation.project)])
  const showContextBar = useConversationsStore(s => s.controlPanelPrefs.showContextInList)
  const showCost = useConversationsStore(s => s.controlPanelPrefs.showCostInList)
  const showRecapDesc = useConversationsStore(s => s.controlPanelPrefs.showRecapDescInList)
  const isRenaming = useConversationsStore(s => s.renamingConversationId === conversation.id)
  const isEditingDescription = useConversationsStore(s => s.editingDescriptionConversationId === conversation.id)
  const projectName = projectDisplayName(projectPath(conversation.project), ps?.label)
  const conversationName = conversation.title || conversation.agentName
  const displayColor = ps?.color
  // Ghost: a live daemon worker (in the roster) that claudewerk is NOT hosting.
  // "Hosted" = has a live agent-host connection (connectionIds). A pure roster
  // mirror has none; attaching connects a daemon-host -> connectionIds populate
  // -> the ghost solidifies. (transport is not plumbed to the FE, so we key on
  // connectionIds, which is -- and which also re-ghosts if the host drops.)
  const ghostShort = useGhostShort(conversation.id)
  const isGhost = !!ghostShort && (conversation.connectionIds?.length ?? 0) === 0

  function handleClick() {
    haptic('tap')
    selectConversation(conversation.id, 'click')
  }

  return (
    <ConversationItemShell
      conversation={conversation}
      isSelected={isSelected}
      displayColor={displayColor}
      variant="full"
      ghost={isGhost}
      onClick={handleClick}
    >
      <div className="flex items-center gap-1.5">
        {isGhost ? (
          <GhostStatusDot />
        ) : (
          <StatusIndicator status={conversation.status} adHoc={conversation.capabilities?.includes('ad-hoc')} />
        )}
        <BackendIcon backend={conversation.backend} transport={conversation.transport} />
        {ps?.icon && (
          <span style={displayColor && !isSelected ? { color: displayColor } : undefined}>
            {renderProjectIcon(ps.icon)}
          </span>
        )}
        <span
          className={cn('font-bold text-sm flex-1 truncate', isSelected ? 'text-accent' : 'text-primary')}
          style={displayColor && !isSelected ? { color: displayColor } : undefined}
        >
          {projectName}
        </span>
        {isGhost && <GhostBadge />}
        {isGhost && <GhostAttachButton conversationId={conversation.id} />}
        {!isGhost && isDaemonTransport(conversation) && (
          <span
            className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-sky-500/20 text-sky-400 border border-sky-500/50"
            title="Native claude agents background session -- claudewerk mirrors it read-only"
          >
            native
          </span>
        )}
        {conversation.planMode && (
          <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-blue-500/20 text-blue-400 border border-blue-500/50">
            plan
          </span>
        )}
        {conversation.compacting && (
          <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-400/20 text-amber-400 border border-amber-400/50 animate-pulse">
            compacting
          </span>
        )}
        {conversation.lastError && (
          <span
            className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-destructive/20 text-destructive border border-destructive/50"
            title={conversation.lastError.errorMessage || conversation.lastError.errorType || 'API error'}
          >
            error
          </span>
        )}
        {conversation.rateLimit && !conversation.lastError && (
          <span
            className="px-1 py-0.5 text-amber-400 border border-amber-500/40 bg-amber-500/20"
            title={`${conversation.rateLimit.message}${formatResetIn(conversation.rateLimit.resetsAt) ? ` (${formatResetIn(conversation.rateLimit.resetsAt)})` : ''}`}
          >
            <Clock size={12} />
          </span>
        )}
        <ConversationAttentionBadges conversation={conversation} />
        <ConversationInfoButton conversation={conversation} visible={isSelected} />
        <ShareIndicator conversationProject={conversation.project} conversationId={conversation.id} />
        {conversation.resultText && conversation.capabilities?.includes('ad-hoc') && (
          <ResultTextModal conversation={conversation} />
        )}
        {conversation.status === 'ended' && <DismissButton conversationId={conversation.id} />}
      </div>
      {(isRenaming || conversationName) && (
        <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate pl-1">
          {isRenaming ? <InlineRename conversation={conversation} /> : conversationName}
        </div>
      )}
      <SpawnedFromSubtext conversation={conversation} padClass="pl-1" />
      {isEditingDescription ? (
        <div className="mt-0.5 pl-1">
          <InlineDescription conversation={conversation} />
        </div>
      ) : conversation.description ? (
        <div
          className="mt-0.5 text-[10px] text-muted-foreground/60 truncate pl-1 italic"
          title={conversation.description}
        >
          {conversation.description}
        </div>
      ) : null}
      {!isRenaming && conversation.recap?.title && (
        <div className="mt-0.5 text-[10px] text-zinc-400/80 truncate pl-1">{conversation.recap.title}</div>
      )}
      {conversation.gitBranch && conversation.gitBranch !== 'main' && conversation.gitBranch !== 'master' && (
        <div className="mt-0.5 pl-1 flex items-center gap-1">
          <span
            className={cn(
              'text-[9px] font-mono truncate',
              conversation.adHocWorktree ? 'text-orange-400/70' : 'text-purple-400/60',
            )}
          >
            {conversation.adHocWorktree ? '\u2387 ' : '\u2325 '}
            {conversation.gitBranch}
          </span>
        </div>
      )}
      <ConversationItemTasksBlock conversation={conversation} selectedSubagentId={selectedSubagentId} />
      {(conversation.runningBgTaskCount > 0 || conversation.team) && (
        <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
          {conversation.runningBgTaskCount > 0 && (
            <span
              role="button"
              tabIndex={0}
              className="px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 text-[10px] font-bold cursor-pointer hover:bg-emerald-400/30"
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
            <span className="px-1.5 py-0.5 bg-purple-400/20 text-purple-400 border border-purple-400/50 text-[10px] font-bold uppercase">
              {conversation.team.role === 'lead' ? 'LEAD' : 'TEAM'} {conversation.team.teamName}
              {conversation.teammates.length > 0 &&
                ` (${conversation.teammates.filter(t => t.status !== 'stopped').length}/${conversation.teammates.length})`}
            </span>
          )}
        </div>
      )}
      {conversation.summary && (
        <div className="mt-1 text-[10px] text-muted-foreground truncate" title={conversation.summary}>
          {conversation.summary}
        </div>
      )}
      {showRecapDesc && !conversation.summary && conversation.recap && (
        <div
          className={cn(
            'mt-1.5 text-[10px] whitespace-pre-wrap overflow-hidden transition-all duration-700',
            conversation.recapFresh
              ? 'text-zinc-300/80 border-l-2 border-zinc-500/50 pl-2 py-0.5 bg-zinc-800/20 rounded-r'
              : 'text-muted-foreground/50 italic pl-1',
          )}
          title={conversation.recap.content}
        >
          {conversation.recap.content}
        </div>
      )}
      {conversation.prLinks && conversation.prLinks.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {conversation.prLinks.map(pr => (
            <a
              key={pr.prUrl}
              href={pr.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-[10px] font-mono text-sky-400 hover:text-sky-300 transition-colors"
              title={`${pr.prRepository}#${pr.prNumber}`}
            >
              PR#{pr.prNumber}
            </a>
          ))}
        </div>
      )}
      {conversation.linkedProjects && conversation.linkedProjects.length > 0 && (
        <div className="mt-1 text-[10px] text-teal-400/50 font-mono truncate">
          {'\u2194'} {conversation.linkedProjects.map(p => p.name).join(', ')}
        </div>
      )}
      {showContextBar &&
        conversation.tokenUsage &&
        (() => {
          const { input, cacheCreation, cacheRead } = conversation.tokenUsage
          const total = input + cacheCreation + cacheRead
          if (total === 0) return null
          const maxTokens = conversation.contextWindow ?? contextWindowSize(conversation.model)
          const pct = Math.min(100, Math.round((total / maxTokens) * 100))
          const threshold = conversation.autocompactPct || 83
          const warnAt = threshold - 5
          return (
            <div className="mt-1.5 flex items-center gap-1.5">
              <div className="flex-1 h-1 bg-muted/50 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    pct < warnAt ? 'bg-emerald-400/60' : pct < threshold ? 'bg-amber-400/60' : 'bg-red-400/70',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span
                className={cn(
                  'text-[9px] font-mono tabular-nums shrink-0',
                  pct < warnAt ? 'text-emerald-400/50' : pct < threshold ? 'text-amber-400/50' : 'text-red-400/60',
                )}
              >
                {pct}%
              </span>
            </div>
          )
        })()}
      {conversation.status === 'idle' &&
        (() => {
          const ci = getCacheTimerInfo(
            conversation.lastTurnEndedAt,
            conversation.tokenUsage,
            conversation.model,
            conversation.cacheTtl,
          )
          if (!ci || ci.state === 'hot') return null
          if (ci.state === 'expired') {
            const idleMin = Math.floor((Date.now() - (conversation.lastTurnEndedAt || 0)) / 60_000)
            return (
              <div className="mt-1 text-[9px] font-mono text-amber-400/60 truncate">
                cache expired ({idleMin}m idle) -- ~${ci.reCacheCost.toFixed(2)} re-cache
              </div>
            )
          }
          return null
        })()}
      {/* ── Meta footer (Design B) -- profile chip first, then host alias, cost, WT ── */}
      {(() => {
        const items: ReactNode[] = []
        items.push(
          <SentinelProfileBadge
            key="profile"
            resolvedProfile={conversation.resolvedProfile}
            hostSentinelAlias={conversation.hostSentinelAlias}
            launchConfig={conversation.launchConfig}
          />,
        )
        if (conversation.hostSentinelAlias && conversation.hostSentinelAlias !== 'default')
          items.push(
            <span key="host" className="px-1 py-0.5 text-[8px] rounded bg-muted text-muted-foreground font-medium">
              {conversation.hostSentinelAlias}
            </span>,
          )
        if (showCost && conversation.stats) {
          const { cost, exact } = getConversationCost(conversation.stats, conversation.model)
          if (cost >= 0.01) {
            const level = getCostLevel(cost)
            items.push(
              <span
                key="cost"
                className={cn(
                  'text-[9px] font-mono',
                  level === 'low' ? 'text-emerald-400/40' : cn('px-1 py-0.5 font-bold border', getCostBgColor(cost)),
                )}
                title={`Cost: ${formatCost(cost, exact)}`}
              >
                {formatCost(cost, exact)}
              </span>,
            )
          }
        }
        if (conversation.adHocWorktree)
          items.push(
            <span key="wt" className="text-[9px] text-orange-400 font-bold">
              WT
            </span>,
          )
        if (items.length === 0) return null
        return (
          <div className="mt-1.5 flex items-center gap-1.5 text-[9px]">
            {items.map((node, i) => (
              <span key={i} className="contents">
                {i > 0 && <span className="text-muted-foreground/30">·</span>}
                {node}
              </span>
            ))}
          </div>
        )
      })()}
    </ConversationItemShell>
  )
})
