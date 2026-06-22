// The WATCHDOG decision log for the Status screen (plan-nightshift.md §2.5):
// every consideration the deterministic watchdog made, timestamped -- not just
// the kills (the LOG-EVERYTHING covenant). Backfilled + live-fed by
// useNightshiftWatchdog.
import type { WatchdogDecision, WatchdogVerdict } from '@shared/protocol'
import { cn, formatTime } from '@/lib/utils'

const VERDICT_TONE: Record<WatchdogVerdict, string> = {
  observe: 'text-muted-foreground border-border',
  warn: 'text-warning border-warning/40',
  block: 'text-active border-active/40',
  end: 'text-destructive border-destructive/40',
}

function VerdictPill({ verdict, kind }: { verdict: WatchdogVerdict; kind?: string }) {
  return (
    <span
      className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tabular-nums', VERDICT_TONE[verdict])}
    >
      {verdict}
      {kind ? ` · ${kind}` : ''}
    </span>
  )
}

/** Compact metric chips -- the snapshot the watchdog measured at decision time. */
function Metrics({ d }: { d: WatchdogDecision }) {
  const chips: string[] = []
  if (d.elapsedMin !== undefined) chips.push(`${d.elapsedMin}m`)
  if (d.turns !== undefined) chips.push(`${d.turns}t`)
  if (d.tokens !== undefined) chips.push(`${d.tokens.toLocaleString('en-US')} tok`)
  if (d.fiveHourPct !== undefined) chips.push(`${d.fiveHourPct}% 5h`)
  if (chips.length === 0) return null
  return <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">{chips.join(' · ')}</span>
}

function DecisionRow({ d }: { d: WatchdogDecision }) {
  return (
    <div className="flex items-start gap-2 border-t border-border/50 px-3 py-1.5 text-[11px]">
      <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">{formatTime(d.at)}</span>
      <VerdictPill verdict={d.verdict} kind={d.kind} />
      <span className="w-8 shrink-0 font-mono text-muted-foreground">{d.taskId}</span>
      <span className="min-w-0 flex-1 truncate" title={d.reason}>
        {d.reason}
      </span>
      <Metrics d={d} />
    </div>
  )
}

export function NightshiftStatusDecisions({ decisions }: { decisions: WatchdogDecision[] }) {
  if (decisions.length === 0) {
    return (
      <p className="px-3 py-4 text-[11px] text-muted-foreground">
        No watchdog decisions yet -- the sweep logs one per task each minute.
      </p>
    )
  }
  return (
    <div className="max-h-[40vh] overflow-y-auto">
      {decisions.map(d => (
        <DecisionRow key={d.id} d={d} />
      ))}
    </div>
  )
}
