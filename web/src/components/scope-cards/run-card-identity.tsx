import { projectPath } from '@/lib/types'
import { ScopeLine, ScopeSection } from './scope-stat'

/**
 * WHAT this run is, as opposed to what it did: the model/effort/profile line and
 * where on disk it is working. `currentPath` is shown only when it DIVERGES from
 * the project root -- i.e. the agent stepped into a worktree, which is exactly
 * when knowing the path matters.
 */
export function RunIdentity({
  model,
  effort,
  profile,
  branch,
  currentPath,
  project,
}: {
  model: string
  effort?: string
  profile?: string
  branch: { label: string; title: string } | null
  currentPath?: string
  project: string
}) {
  const root = projectPath(project)
  const worktree = currentPath && currentPath !== root ? currentPath : null
  return (
    <ScopeSection>
      <div className="text-[10px] text-muted-foreground/80 truncate">
        {[model, effort, profile].filter(Boolean).join(' · ')}
      </div>
      {branch && <ScopeLine label="branch" value={branch.label} tone="text-purple-300/80" title={branch.title} />}
      {worktree && <ScopeLine label="worktree" value={worktree} tone="text-violet-300/80" title={worktree} />}
    </ScopeSection>
  )
}
