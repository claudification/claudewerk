/**
 * SOTU viewer Universe tab -- the fleet rollup cards. Split from
 * sotu-viewer-sections.tsx (the Project-tab sections live there).
 */

import { Markdown } from './markdown'
import type { FleetProject } from './sotu-viewer-types'

export function UniverseView({
  projects,
  error,
  onSelect,
}: {
  projects: FleetProject[] | null
  error: string | null
  onSelect: (projectUri: string) => void
}) {
  if (error) return <p className="text-rose-400 text-xs p-4">{error}</p>
  if (!projects) return <p className="text-comment text-xs p-4">Loading...</p>
  const enabled = projects.filter(p => p.enabled)
  const withActivity = projects.filter(p => p.queueSize > 0 || p.view.chronicle.now.length > 0)
  return (
    <div className="p-4 overflow-y-auto flex-1">
      <div className="text-xs text-comment mb-3">
        {projects.length} projects -- {enabled.length} enabled -- {withActivity.length} with activity
      </div>
      <div className="space-y-3">
        {(withActivity.length > 0 ? withActivity : projects.slice(0, 20)).map(p => (
          <button
            type="button"
            key={p.projectUri}
            onClick={() => onSelect(p.projectUri)}
            className="w-full text-left rounded-lg border border-border/50 p-3 transition-colors hover:border-accent/60 hover:bg-accent/5"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`h-1.5 w-1.5 rounded-full ${p.enabled ? 'bg-accent' : 'bg-comment/30'}`} />
              <span className="font-mono text-[11px] font-medium">{p.project}</span>
              <span className="text-[10px] text-comment ml-auto">{p.queueSize} queued</span>
            </div>
            {p.view.chronicle.narrative && (
              // Clamp targets Markdown's own wrapper div -- inline-parsed output
              // has no block children, so -webkit-box clamping stays reliable.
              <div className="text-[11px] text-foreground/70 leading-relaxed [&>div]:line-clamp-2">
                <Markdown inline>{p.view.chronicle.narrative}</Markdown>
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
