// Live nightshift night-ops Status screen (plan-nightshift.md §2.5). Optional
// surface for when Jonas is up late: per-task rows (live fleet), per-profile
// capacity burn-down (smart-balance telemetry), and the deterministic WATCHDOG
// decision log. Pure diagnostics + dopamine -- lazy-routed at #/nightshift-status.
import { useEffect, useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useNightshiftWatchdog } from '@/hooks/use-nightshift-watchdog'
import { selectConversations } from '@/lib/slim-conversation'
import { NightshiftStatusCapacity } from './nightshift-status-capacity'
import { NightshiftStatusDecisions } from './nightshift-status-decisions'
import { NightshiftStatusTasks } from './nightshift-status-tasks'

function BackButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.location.hash = ''
      }}
      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      &larr; back
    </button>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/30">
      <h2 className="flex items-center gap-2 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count !== undefined && <span className="tabular-nums text-muted-foreground/60">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

/** One-second tick so elapsed times stay live without per-row timers. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function NightshiftStatusPage() {
  const projectUri = useConversationsStore(s => s.selectedProjectUri)
  const byId = useConversationsStore(s => s.conversationsById)
  const profileUsage = useConversationsStore(s => s.profileUsage)
  const { decisions, error, refetch } = useNightshiftWatchdog(projectUri)
  const now = useNow(!!projectUri)

  const tasks = useMemo(
    () => (projectUri ? selectConversations(byId).filter(c => c.nightshift && c.project === projectUri) : []),
    [byId, projectUri],
  )
  const profiles = useMemo(() => Object.values(profileUsage), [profileUsage])

  if (!projectUri) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>Open a project to watch its night ops.</p>
        <BackButton />
      </div>
    )
  }

  const liveCount = tasks.filter(c => c.status === 'active' || c.status === 'idle').length

  return (
    <div className="fixed inset-0 overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-8">
        <div className="flex items-center justify-between">
          <BackButton />
          <span className="font-mono text-xs text-muted-foreground">
            NIGHTSHIFT · STATUS <span className="text-muted-foreground/60">({liveCount} live)</span>
          </span>
        </div>

        <Section title="Tasks" count={tasks.length}>
          <NightshiftStatusTasks tasks={tasks} now={now} />
        </Section>

        <Section title="Capacity burn-down" count={profiles.length}>
          <div className="px-3 py-2">
            <NightshiftStatusCapacity profiles={profiles} />
          </div>
        </Section>

        <Section title="Watchdog decision log" count={decisions.length}>
          {error ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px]">
              <span className="text-destructive">{error}</span>
              <button type="button" onClick={refetch} className="text-muted-foreground hover:text-foreground">
                retry
              </button>
            </div>
          ) : (
            <NightshiftStatusDecisions decisions={decisions} />
          )}
        </Section>
      </div>
    </div>
  )
}
