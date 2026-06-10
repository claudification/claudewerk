import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import { formatCost, getConversationCost, getCostColor } from '@/lib/cost-utils'
import { useKeyLayer } from '@/lib/key-layers'
import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import { cn, contextWindowSize, formatDurationMs, formatEffort, formatModel, haptic, truncate } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { LaunchParamsSection } from './launch-params-section'
import { StatusIndicator } from './status-indicator'

function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Lineage rows for the info dialog: who spawned this conversation and which
 *  conversations it spawned. Children are walked from the local list (the
 *  authoritative live source). Each entry navigates + closes the dialog. */
function ConversationLineageSection({
  conversation,
  onNavigate,
}: {
  conversation: Conversation
  onNavigate: (id: string) => void
}) {
  const parent = useConversationsStore(s =>
    conversation.parentConversationId ? s.conversationsById[conversation.parentConversationId] : undefined,
  )
  const children = useConversationsStore(
    useShallow(s => selectConversations(s.conversationsById).filter(c => c.parentConversationId === conversation.id)),
  )
  const hasParent = !!conversation.parentConversationId
  if (!hasParent && children.length === 0) return null
  return (
    <>
      <div className="border-t border-border" />
      {hasParent && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Spawned from</span>
          {parent ? (
            <button
              type="button"
              onClick={() => onNavigate(parent.id)}
              className="ml-auto text-accent hover:underline truncate max-w-[200px]"
            >
              {parent.title || parent.agentName || parent.id.slice(0, 8)}
            </button>
          ) : (
            <span className="ml-auto text-muted-foreground/60 italic">(deleted)</span>
          )}
        </div>
      )}
      {children.length > 0 && (
        <div className="space-y-1">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
            Direct children ({children.length})
          </span>
          <div className="space-y-0.5">
            {children.map(child => (
              <button
                key={child.id}
                type="button"
                onClick={() => onNavigate(child.id)}
                className="flex items-center gap-1.5 w-full text-left px-1 py-0.5 rounded hover:bg-accent/10 transition-colors"
              >
                <StatusIndicator status={child.status} adHoc={child.capabilities?.includes('ad-hoc')} />
                <span className="truncate text-foreground/80">
                  {child.title || child.agentName || child.id.slice(0, 8)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function TokenUsageBlock({ stats }: { stats: NonNullable<Conversation['stats']> }) {
  return (
    <>
      <div className="border-t border-border" />
      <div className="space-y-1">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Tokens</span>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
          <span className="text-muted-foreground">input</span>
          <span className="text-right tabular-nums text-foreground/80">{formatTokenCount(stats.totalInputTokens)}</span>
          <span className="text-muted-foreground">output</span>
          <span className="text-right tabular-nums text-foreground/80">
            {formatTokenCount(stats.totalOutputTokens)}
          </span>
          {stats.totalCacheRead > 0 && (
            <>
              <span className="text-muted-foreground">cache read</span>
              <span className="text-right tabular-nums text-emerald-400">{formatTokenCount(stats.totalCacheRead)}</span>
            </>
          )}
          {stats.totalCacheCreation > 0 && (
            <>
              <span className="text-muted-foreground">cache write</span>
              <span className="text-right tabular-nums text-amber-400">
                {formatTokenCount(stats.totalCacheCreation)}
              </span>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export function ConversationInfoDialog({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: Conversation
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const resolvedModel = conversation.model
  const effort = formatEffort(conversation.effortLevel)
  const cost = conversation.stats ? getConversationCost(conversation.stats, resolvedModel) : null
  const duration = conversation.lastActivity - conversation.startedAt
  const isAdHoc = conversation.capabilities?.includes('ad-hoc')
  const selectConversation = useConversationsStore(s => s.selectConversation)

  useKeyLayer({ Escape: () => onOpenChange(false) }, { id: 'conversation-info-dialog', enabled: open })

  function navigateToConversation(id: string) {
    haptic('tap')
    selectConversation(id, 'click')
    onOpenChange(false)
  }

  const stats = conversation.stats
  const hasTokenUsage = !!stats && (stats.totalInputTokens > 0 || stats.totalOutputTokens > 0)
  const hasContextBar = !!stats && stats.totalInputTokens > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="font-mono max-w-sm p-4">
        <DialogTitle className="pr-8 pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-accent">{'ⓘ'}</span>
            <span>Conversation Info</span>
            <span className="text-[10px] text-muted-foreground/50 font-normal">{conversation.id.slice(0, 12)}</span>
          </div>
        </DialogTitle>
        <div className="space-y-2 text-[11px]">
          {/* Model + effort */}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Model</span>
            <span className="ml-auto text-primary">{formatModel(resolvedModel)}</span>
            {effort && (
              <span className="text-foreground/60">
                {effort.symbol} {effort.label}
              </span>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Cost */}
          {cost && cost.cost > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Cost</span>
              <span className={cn('ml-auto font-bold', getCostColor(cost.cost))}>
                {formatCost(cost.cost, cost.exact)}
              </span>
            </div>
          )}

          {/* Duration */}
          {duration > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Duration</span>
              <span className="ml-auto text-foreground/80">{formatDurationMs(duration)}</span>
            </div>
          )}

          {/* Turn count */}
          {stats && stats.turnCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Turns</span>
              <span className="ml-auto text-foreground/80">{stats.turnCount}</span>
            </div>
          )}

          {/* Token usage */}
          {hasTokenUsage && stats && <TokenUsageBlock stats={stats} />}

          {/* Context window */}
          {hasContextBar && stats && (
            <>
              <div className="border-t border-border" />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Context</span>
                <span className="ml-auto text-foreground/80">
                  {formatTokenCount(stats.totalInputTokens)} /{' '}
                  {formatTokenCount(conversation.contextWindow ?? contextWindowSize(resolvedModel))}
                </span>
              </div>
            </>
          )}

          {/* Git branch */}
          {conversation.gitBranch && (
            <>
              <div className="border-t border-border" />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Branch</span>
                <span className="ml-auto text-sky-400 truncate max-w-[200px]">{conversation.gitBranch}</span>
              </div>
            </>
          )}

          {/* Identity */}
          {conversation.claudeAuth?.email && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Auth</span>
              <span className="ml-auto text-foreground/80 truncate max-w-[200px]">
                {conversation.claudeAuth.email}
                {conversation.claudeAuth.orgName && (
                  <span className="text-muted-foreground"> ({conversation.claudeAuth.orgName})</span>
                )}
              </span>
            </div>
          )}

          {/* Launch parameters */}
          <LaunchParamsSection conversation={conversation} />

          {/* Ad-hoc result preview */}
          {isAdHoc && conversation.resultText && (
            <>
              <div className="border-t border-border" />
              <div className="space-y-1">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Result</span>
                <div className="text-[10px] text-foreground/70 line-clamp-6 break-words">
                  {truncate(conversation.resultText, 400)}
                </div>
              </div>
            </>
          )}

          {/* Spawn lineage: parent + direct children */}
          <ConversationLineageSection conversation={conversation} onNavigate={navigateToConversation} />

          {/* Conversation ID */}
          <div className="border-t border-border/50" />
          <div className="text-[9px] text-muted-foreground/50 select-all">{conversation.id}</div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ConversationInfoButton({ conversation, visible }: { conversation: Conversation; visible: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* nested inside conversation-row interactive; semantic <button> would be invalid HTML */}
      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role */}
      <span
        role="button"
        tabIndex={0}
        className={cn(
          'text-[10px] text-muted-foreground/50 hover:text-accent cursor-pointer transition-all shrink-0',
          visible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        title="Conversation info"
        onClick={e => {
          e.stopPropagation()
          haptic('tap')
          setOpen(true)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation()
            haptic('tap')
            setOpen(true)
          }
        }}
      >
        {'ⓘ'}
      </span>
      <ConversationInfoDialog conversation={conversation} open={open} onOpenChange={setOpen} />
    </>
  )
}
