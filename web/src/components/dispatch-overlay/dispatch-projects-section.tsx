import { truncate } from '@/lib/utils'
import { useDispatchStore } from './dispatch-store'

/** A compact one-line count summary for a project ("2 live · 1 needs-you"). */
function counts(p: { live: number; working: number; needsYou: number; idleMin?: number }): string {
  if (p.live === 0) return 'idle · in memory'
  const parts: Array<[boolean, string]> = [
    [true, `${p.live} live`],
    [p.working > 0, `${p.working} working`],
    [p.needsYou > 0, `${p.needsYou} needs-you`],
    [p.idleMin !== undefined, `idle ${p.idleMin}m`],
  ]
  return parts
    .filter(([on]) => on)
    .map(([, label]) => label)
    .join(' · ')
}

/** The dispatcher's project-anchored MEMORY, made visible: every project the
 *  brain knows, with its condensed brief + live counts. This is the headline of
 *  the front desk -- PROJECTS first. Renders nothing until memory exists. */
export function ProjectsSection() {
  const projects = useDispatchStore(s => s.projects)
  if (projects.length === 0) return null
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.2em] text-comment">by project</span>
      <div className="mt-3 flex flex-col gap-2">
        {projects.map(p => (
          <div key={p.projectUri} className="rounded-xl border border-border/70 bg-card/40 px-3.5 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-foreground/90">{p.project}</span>
              <span className="flex-none text-[10px] text-comment/70">{counts(p)}</span>
            </div>
            {p.brief && (
              <span className="mt-1 block text-[11.5px] leading-snug text-comment">{truncate(p.brief, 220)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
