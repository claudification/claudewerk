/**
 * Collapsible "Recent commits" section for the ProjectActionPanel -- every
 * commit in this project, across every worktree, conversation and machine.
 * Renders nothing when the ledger has nothing for the project, so a repo with
 * no hook installed costs no screen space.
 */

import { useState } from 'react'
import { haptic } from '@/lib/utils'
import { CommitRowItem } from '../commits/commit-row'
import { useCommits } from '../commits/use-commits'

const PREVIEW = 8

export function ProjectCommitsSection({ projectUri }: { projectUri: string }) {
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { commits, total } = useCommits({ projectUris: [projectUri], limit: 50 })

  if (commits.length === 0) return null
  const shown = expanded ? commits : commits.slice(0, PREVIEW)

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          setCollapsed(c => !c)
        }}
        className="w-full text-[10px] text-emerald-400/70 font-bold uppercase tracking-wider px-1 flex items-center gap-2"
      >
        <span className="shrink-0 w-2 text-left">{collapsed ? '▸' : '▾'}</span>
        <span>Recent commits ({total})</span>
        <span className="flex-1 h-px bg-emerald-400/20" />
      </button>
      {!collapsed && (
        <>
          <div className="space-y-1">
            {shown.map(commit => (
              <CommitRowItem key={`${commit.repoUri}:${commit.hash}`} commit={commit} />
            ))}
          </div>
          {commits.length > PREVIEW && (
            <button
              type="button"
              className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground px-1 transition-colors"
              onClick={() => {
                haptic('tap')
                setExpanded(e => !e)
              }}
            >
              {expanded ? 'Show fewer' : `Show all ${commits.length} loaded`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
