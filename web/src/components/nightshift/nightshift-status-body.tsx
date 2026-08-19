/**
 * Live nightshift night-ops view (plan-nightshift.md §2.5), as a modal-hostable
 * body: per-task rows (live fleet), per-profile capacity burn-down, and the
 * deterministic WATCHDOG decision log. Mounted only while the Status tab is open.
 */
import { useEffect, useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useNightshiftWatchdog } from '@/hooks/use-nightshift-watchdog'
import { selectConversations } from '@/lib/slim-conversation'
import { NightshiftStatusCapacity } from './nightshift-status-capacity'
import { NightshiftStatusDecisions } from './nightshift-status-decisions'
import { NightshiftStatusTasks } from './nightshift-status-tasks'

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/30">
      <h2 className="flex items-center gap-2 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count !== undefined && <span className="tabular-nums text-fg-dim">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

/** One-second tick so elapsed times stay live without per-row timers. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function NightshiftStatusBody({ projectUri }: { projectUri: string }) {
  const byId = useConversationsStore(s => s.conversationsById)
  const profileUsage = useConversationsStore(s => s.profileUsage)
  const { decisions, error, refetch } = useNightshiftWatchdog(projectUri)
  const now = useNow()

  const tasks = useMemo(
    () => selectConversations(byId).filter(c => c.nightshift && c.project === projectUri),
    [byId, projectUri],
  )
  const profiles = useMemo(() => Object.values(profileUsage), [profileUsage])
  const liveCount = tasks.filter(c => c.status === 'active' || c.status === 'idle').length

  return (
    <div className="space-y-4">
      <div className="text-right font-mono text-[10px] text-fg-dim">{liveCount} live</div>
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
  )
}
