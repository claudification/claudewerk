/**
 * The archived cards, folded away.
 *
 * Its own component because it owns its own open/closed state, and leaving that
 * one `useState` in `ProjectBoard` meant the orchestrator re-rendered the whole
 * board every time someone peeked at the archive.
 */

import type { ProjectTaskMeta } from '@shared/project-task-types'
import { Archive, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { haptic } from '@/lib/utils'

export function BoardArchiveDrawer({
  tasks,
  renderCard,
}: {
  tasks: ProjectTaskMeta[]
  renderCard: (task: ProjectTaskMeta) => React.ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  if (tasks.length === 0) return null

  return (
    <div className="border-t border-border shrink-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        onClick={() => {
          haptic('tap')
          setExpanded(v => !v)
        }}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Archive className="size-3" />
        <span className="text-chrome font-mono uppercase">Archived</span>
        <span className="text-meta font-mono tabular-nums">{tasks.length}</span>
      </button>
      {expanded && (
        <div className="max-h-[200px] overflow-y-auto border-t border-border/30">{tasks.map(renderCard)}</div>
      )}
    </div>
  )
}
