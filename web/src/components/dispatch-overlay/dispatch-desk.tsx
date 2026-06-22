import { formatAge, truncate } from '@/lib/utils'
import { MemorySection, WorkspaceSection } from './dispatch-memory-section'
import { ProjectsSection } from './dispatch-projects-section'
import { useDispatchStore } from './dispatch-store'

/** The LIVE roster the desk covers ("active right now" -- tap to open). */
function RosterSection() {
  const roster = useDispatchStore(s => s.roster)
  const routeTo = useDispatchStore(s => s.routeTo)
  if (roster.length === 0) return null
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.2em] text-comment">active right now</span>
      <div className="mt-3 flex flex-col gap-2">
        {roster.slice(0, 6).map(c => (
          <button
            key={c.conversationId}
            type="button"
            onClick={() => routeTo(c.conversationId)}
            className="flex flex-col gap-0.5 rounded-xl border border-border/70 bg-card/40 px-3.5 py-2.5 text-left transition-colors hover:border-[color-mix(in_oklch,var(--accent)_45%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="truncate text-[13px] font-medium text-foreground/90">
              {c.title || c.project || c.conversationId.slice(0, 8)}
            </span>
            {c.commentary && <span className="text-[11.5px] leading-snug text-comment">{c.commentary}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The dispatcher's near-memory threads ("on my desk"), collapsible. */
function ThreadsSection() {
  const threads = useDispatchStore(s => s.threads)
  const showThreads = useDispatchStore(s => s.showThreads)
  const toggleThreads = useDispatchStore(s => s.toggleThreads)
  if (threads.length === 0) return null
  return (
    <div>
      <button
        type="button"
        onClick={toggleThreads}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em] text-comment transition-colors hover:text-foreground/80 focus-visible:outline-none"
      >
        <span className="text-[9px]">{showThreads ? '▾' : '▸'}</span>
        on my desk
      </button>
      {showThreads && (
        <div className="mt-3 flex flex-col gap-2">
          {threads.slice(0, 4).map(t => (
            <div key={t.id} className="rounded-xl border border-border/70 bg-card/40 px-3.5 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-foreground/90">{t.title}</span>
                <span className="flex-none text-[10px] text-comment/70">{formatAge(t.updatedAt)}</span>
              </div>
              {t.summary && (
                <span className="mt-0.5 block text-[11.5px] leading-snug text-comment">{truncate(t.summary, 130)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** What the concierge is holding right now: PROJECTS first (its project-anchored
 *  memory), then the live roster, near-memory threads, durable notes + workspace.
 *  Light, not a fleet dashboard; renders nothing when everything is empty. */
export function DispatchDesk() {
  const projects = useDispatchStore(s => s.projects)
  const roster = useDispatchStore(s => s.roster)
  const threads = useDispatchStore(s => s.threads)
  const memory = useDispatchStore(s => s.memory)
  const itemCount = projects.length + roster.length + threads.length
  if (itemCount === 0 && !memory.trim()) return null

  return (
    <div className="flex flex-col gap-7 px-6 pt-8">
      <ProjectsSection />
      <RosterSection />
      <ThreadsSection />
      <MemorySection />
      <WorkspaceSection />
    </div>
  )
}
