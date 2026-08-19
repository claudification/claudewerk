import { projectIdentityKey } from '@shared/project-uri'
import { useConversationsStore } from '@/hooks/use-conversations'
import { openKanbanModal } from '@/hooks/use-kanban-modal'
import { useProjectCommitStats } from '@/hooks/use-project-commit-stats'
import { useProjectIntegration } from '@/hooks/use-project-integration'
import { useProjectTaskCounts } from '@/hooks/use-project-task-counts'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { openRecapHistory } from '../recap-jobs/recap-history-trigger'
import { PlaceCommits, PlaceIntegration } from './place-card-sections'
import { ScopeLink, ScopeLinks, ScopeSection, ScopeStat, ScopeStats } from './scope-stat'
import { useProjectConversationCounts } from './use-project-conversation-counts'

/**
 * The PLACE card -- what a project HAS. A project is a PLACE: it has a backlog,
 * a history, and whoever is working in it right now. Every number here belongs
 * to the place, never to one run: no cost, no context window, no per-agent
 * anything. `commits` appears on both cards and means different things -- here
 * it is "what has ever landed here, by anyone", which is why the section is
 * named.
 *
 * Nothing on this card may TRIGGER work: the board counts come through the
 * watch-free path (no sentinel watch per hovered row) and the integration line
 * reads the last git scan and shows its age (never a scan, never a distill).
 */
export function PlaceCard({ project }: { project: string }) {
  const label = useConversationsStore(
    s => s.projectSettings[projectIdentityKey(project)]?.label || extractProjectLabel(project),
  )
  const selectProject = useConversationsStore(s => s.selectProject)
  const board = useProjectTaskCounts(project)
  const convs = useProjectConversationCounts(project)
  const commits = useProjectCommitStats(project)
  const integration = useProjectIntegration(project)

  return (
    <div className="text-[10px]">
      <div className="px-3 py-2 border-b border-border">
        <div className="font-mono text-[11px] font-semibold text-primary truncate">{label}</div>
        <div className="text-[9px] text-fg-dim truncate" title={projectPath(project)}>
          {projectPath(project)}
        </div>
      </div>

      <ScopeSection label="board">
        <ScopeStats>
          <ScopeStat label="open" value={board.loading ? '…' : board.open} />
          <ScopeStat label="in-progress" value={board.loading ? '…' : board['in-progress']} tone="text-active/90" />
          <ScopeStat label="review" value={board.loading ? '…' : board['in-review']} tone="text-amber-400/80" />
          <ScopeStat label="inbox" value={board.loading ? '…' : board.inbox} />
        </ScopeStats>
      </ScopeSection>

      <ScopeSection label="conversations">
        <ScopeStats>
          <ScopeStat label="active" value={convs.active} tone="text-emerald-400/90" />
          <ScopeStat label="idle" value={convs.idle} />
          <ScopeStat label="ended" value={convs.ended} tone="text-fg-dim" />
        </ScopeStats>
      </ScopeSection>

      <PlaceCommits stats={commits} />
      <PlaceIntegration integration={integration} />

      <ScopeLinks>
        <ScopeLink onClick={() => openKanbanModal(project)}>board</ScopeLink>
        <ScopeLink onClick={() => openRecapHistory(project)}>recaps</ScopeLink>
        <ScopeLink onClick={() => selectProject(project)}>project</ScopeLink>
      </ScopeLinks>
    </div>
  )
}
