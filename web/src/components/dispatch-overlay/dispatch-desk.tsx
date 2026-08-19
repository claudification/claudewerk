import { MemorySection, WorkspaceSection } from './dispatch-memory-section'
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
            className="flex flex-col gap-0.5 rounded-xl border border-border bg-card/40 px-3.5 py-2.5 text-left transition-colors hover:border-[color-mix(in_oklch,var(--accent)_45%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

/** A genuinely-visible CONTENDED badge -- two or more conversations are on the same
 *  file/concept right now. In SOTU's passive-collision model this badge IS the whole
 *  coordination mechanism, so it is a filled warning pill, never a faint hint. */
function ContendedBadge({ n }: { n: number }) {
  return (
    <span className="shrink-0 rounded-full bg-[color:var(--warning)]/20 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-[color:var(--warning)]">
      ⚠ {n} contended
    </span>
  )
}

/** Git escalation chips from the SOTU fabric scan (at-risk / unpushed / stalled). */
function AlertChips({ alerts }: { alerts: string[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {alerts.map(a => (
        <span
          key={a}
          className="rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive"
        >
          {a}
        </span>
      ))}
    </div>
  )
}

/** "Where things stand": the per-project status strip. UPGRADED in Phase 5 from the
 *  zero-LLM headline into the real SOTU briefing -- the distilled narrative replaces
 *  the headline when present, plus the live git alerts + the CONTENDED badge (the
 *  passive trample-guard). Falls back to the zero-LLM headline for floor-only/quiet
 *  projects, so nothing regresses when SOTU is off. */
function StatusSection() {
  const status = useDispatchStore(s => s.status)
  if (status.length === 0) return null
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.2em] text-comment">where things stand</span>
      <div className="mt-3 flex flex-col gap-2">
        {status.map(p => {
          const body = p.sotuNarrative || p.headline
          return (
            <div key={p.project} className="rounded-xl border border-border bg-card/40 px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-foreground/90">{p.project}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] text-comment">
                  {p.sotuContended ? <ContendedBadge n={p.sotuContended} /> : null}
                  <span>
                    {p.needsYou > 0 && <span className="text-[color:var(--accent)]">{p.needsYou} needs you · </span>}
                    {p.live} live{p.working > 0 ? ` · ${p.working} working` : ''}
                  </span>
                </span>
              </div>
              {body && <p className="mt-1 text-[11.5px] leading-snug text-comment">{body}</p>}
              {p.sotuAlerts && p.sotuAlerts.length > 0 && <AlertChips alerts={p.sotuAlerts} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** What the GLOBAL concierge is holding right now: the per-project status strip,
 *  the live roster ("active right now"), its durable memory, and scratch
 *  workspaces. The dispatcher is global (one per user, fronts ALL projects) -- it
 *  is NOT anchored to one project, so there is no by-project lead. Threads are
 *  SHORT-TERM memory folded into the dispatcher's context, not a panel. Light, not
 *  a fleet dashboard; renders nothing when everything is empty. */
export function DispatchDesk() {
  const roster = useDispatchStore(s => s.roster)
  const status = useDispatchStore(s => s.status)
  const memory = useDispatchStore(s => s.memory)
  if (roster.length === 0 && status.length === 0 && !memory.trim()) return null

  return (
    <div className="flex flex-col gap-7 px-6 pt-8">
      <StatusSection />
      <RosterSection />
      <MemorySection />
      <WorkspaceSection />
    </div>
  )
}
