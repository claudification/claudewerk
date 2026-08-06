import { projectIdentityKey } from '@shared/project-uri'
import { useConversationsStore } from '@/hooks/use-conversations'
import { deriveContextPct, rowSubtitle, rowTitle } from '@/lib/conversation-row'
import { formatCost, getConversationCost } from '@/lib/cost-utils'
import { formatAgeShort, STATUS_META } from '@/lib/status-style'
import { type Conversation, extractProjectLabel } from '@/lib/types'
import { cn, formatEffort, formatModel } from '@/lib/utils'
import { resolveBranch } from '../project-list/branch-pill'
import { useDirectChildCount } from '../project-list/conversation-item-helpers'
import { RunIdentity } from './run-card-identity'
import { ScopeLink, ScopeLinks, ScopeSection, ScopeStat, ScopeStats } from './scope-stat'

/**
 * The RUN card -- what one conversation IS and what it DID. A conversation is a
 * RUN: it has a lifecycle, a cost, and things it landed. Every number here is
 * already on the summary, so this card renders from the store and fetches
 * NOTHING.
 *
 * There is deliberately no board/Kanban number on it: a board belongs to the
 * PLACE (the project), and putting a place-number on a run is the category error
 * this whole design exists to prevent. The `in <PROJECT> ►` seam is how you step
 * up to the place; there is no reverse link, because a place has many runs and
 * picking one for you would be a guess.
 */

/** The header's state word + tint: the agent's self-reported status when it has
 *  one, else the broker's lifecycle status. */
function headerState(conversation: Conversation): { label: string; tone: string; dot: string } {
  const live = conversation.liveStatus
  if (live) {
    const meta = STATUS_META[live.state]
    return { label: meta.label.toLowerCase(), tone: meta.text, dot: meta.dot }
  }
  const tone =
    conversation.status === 'active'
      ? 'text-emerald-400'
      : conversation.status === 'ended'
        ? 'text-muted-foreground/60'
        : 'text-amber-400/80'
  const dot = conversation.status === 'active' ? 'bg-emerald-400' : 'bg-muted-foreground/50'
  return { label: conversation.status, tone, dot }
}

function taskValue(conversation: Conversation): string {
  const active = conversation.activeTasks.length
  const pending = conversation.pendingTaskCount ?? conversation.pendingTasks.length
  if (active > 0) return `${active} active · ${pending} pending`
  return `${pending} pending`
}

export function RunCard({ conversation, onOpenInfo }: { conversation: Conversation; onOpenInfo?: () => void }) {
  const selectProject = useConversationsStore(s => s.selectProject)
  const projectLabel = useConversationsStore(
    s =>
      s.projectSettings[projectIdentityKey(conversation.project)]?.label || extractProjectLabel(conversation.project),
  )
  const spawned = useDirectChildCount(conversation)
  const state = headerState(conversation)
  const ctx = deriveContextPct(conversation)
  const cost = conversation.stats ? getConversationCost(conversation.stats, conversation.model) : null
  const branch = resolveBranch(conversation)
  const prompt = rowSubtitle(conversation)

  return (
    <div className="text-[10px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <span className={cn('h-2 w-2 rounded-full shrink-0', state.dot)} />
        <span className="font-mono text-[11px] font-semibold truncate flex-1">{rowTitle(conversation, 32)}</span>
        <span className={cn('text-[10px] shrink-0', state.tone)}>{state.label}</span>
        <span className="text-[10px] text-muted-foreground/50 shrink-0">
          {'·'} {formatAgeShort(conversation.lastActivity)}
        </span>
      </div>

      <ScopeSection label="this run">
        <ScopeStats>
          <ScopeStat label="commits" value={conversation.commitCount ?? 0} tone="text-sky-400/90" />
          <ScopeStat label="tasks" value={taskValue(conversation)} />
          <ScopeStat label="subagents" value={conversation.activeSubagentCount} />
          <ScopeStat label="spawned" value={spawned} />
          <ScopeStat
            label="cost"
            value={cost ? formatCost(cost.cost, cost.exact) : '--'}
            tone="text-amber-400/80 font-bold"
          />
          <ScopeStat label="context" value={ctx ? `${ctx.pct}%` : '--'} tone={ctx?.color} />
          {conversation.runningBgTaskCount > 0 && (
            <ScopeStat label="bg tasks" value={conversation.runningBgTaskCount} tone="text-emerald-400/80" />
          )}
        </ScopeStats>
      </ScopeSection>

      <RunIdentity
        model={formatModel(conversation.model)}
        effort={formatEffort(conversation.effortLevel)?.label}
        profile={conversation.resolvedProfile}
        branch={branch}
        currentPath={conversation.currentPath}
        project={conversation.project}
      />

      {prompt && (
        <ScopeSection>
          <div className="text-[10px] text-muted-foreground/70 italic line-clamp-3 break-words">"{prompt}"</div>
        </ScopeSection>
      )}

      <ScopeLinks>
        <ScopeLink onClick={() => selectProject(conversation.project)}>in {projectLabel}</ScopeLink>
        {onOpenInfo && <ScopeLink onClick={onOpenInfo}>full info</ScopeLink>}
      </ScopeLinks>
    </div>
  )
}
