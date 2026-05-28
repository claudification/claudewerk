/**
 * Collapsible per-project section: a sticky accent-railed header (click to
 * toggle), optional worktree pills, and the spawn-forest trees. Collapsed by
 * default -- only the header shows until expanded.
 */

import type { SheafProject } from '@shared/sheaf-types'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import { accentFor } from './accent'
import { costHeatClass, formatCost, formatTokens } from './format'
import { SheafTree } from './sheaf-tree'

interface ProjectSectionProps {
  project: SheafProject
  now: number
  expanded: boolean
  onToggle: () => void
}

function ProjectHeader({ project, expanded, onToggle }: Omit<ProjectSectionProps, 'now'>) {
  const totals = project.totals
  const totalTokens = totals.tokens.input + totals.tokens.output + totals.tokens.cache
  const accent = useMemo(() => accentFor(project.label), [project.label])
  return (
    <div
      className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-background/90 backdrop-blur border-b border-l-2 border-border/60 flex flex-wrap items-baseline gap-x-4 gap-y-1 cursor-pointer select-none"
      style={{
        borderLeftColor: accent.border,
        backgroundImage: `linear-gradient(90deg, ${accent.tint}, transparent 280px)`,
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
    >
      {expanded ? (
        <ChevronDown className="size-4 self-center shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-4 self-center shrink-0 text-muted-foreground" />
      )}
      <span className="size-2 rounded-full shrink-0 self-center" style={{ backgroundColor: accent.border }} />
      <h2 className="text-base font-semibold tracking-tight truncate" title={project.projectUri}>
        {project.label}
      </h2>
      <span className="text-[10px] text-muted-foreground/70 font-mono truncate hidden sm:inline">
        {project.projectUri}
      </span>
      <div className="ml-auto flex items-baseline gap-x-4 text-xs">
        <span className="text-muted-foreground">
          <span className="font-mono font-semibold text-foreground">{totals.convCount}</span> convs
        </span>
        <span className="text-muted-foreground">
          <span className="font-mono font-semibold text-foreground">{totals.treeCount}</span> trees
        </span>
        <span className="text-muted-foreground">
          <span className="font-mono font-semibold text-foreground">{formatTokens(totalTokens)}</span> tok
        </span>
        <span className={`font-mono font-semibold ${costHeatClass(totals.cost.amount)}`}>
          {formatCost(totals.cost.amount, totals.cost.estimated)}
        </span>
      </div>
    </div>
  )
}

function WorktreePills({ project }: { project: SheafProject }) {
  if (project.worktrees.length <= 1) return null
  return (
    <div className="flex flex-wrap gap-2 px-2 py-1">
      {project.worktrees.map(wt => {
        const key = wt.name ?? '(main)'
        const tokens = wt.tokens.input + wt.tokens.output + wt.tokens.cache
        return (
          <div
            key={key}
            className="text-[10px] px-2 py-0.5 rounded border border-border/60 bg-muted/30 flex items-baseline gap-1.5"
          >
            <span className="font-mono">{wt.name ? `worktree:${wt.name}` : '(main)'}</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="font-mono text-foreground">{wt.convCount} convs</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="font-mono text-muted-foreground">{formatTokens(tokens)}</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="font-mono">{formatCost(wt.cost.amount, wt.cost.estimated)}</span>
          </div>
        )
      })}
    </div>
  )
}

export function ProjectSection({ project, now, expanded, onToggle }: ProjectSectionProps) {
  const accent = useMemo(() => accentFor(project.label), [project.label])
  return (
    <section className="space-y-2">
      <ProjectHeader project={project} expanded={expanded} onToggle={onToggle} />
      {expanded && <WorktreePills project={project} />}
      {expanded && (
        <div className="space-y-2 border-l-2 pl-2 ml-1" style={{ borderLeftColor: accent.tint }}>
          {project.forest.map(root => (
            <SheafTree key={root.id} root={root} now={now} />
          ))}
        </div>
      )}
    </section>
  )
}
