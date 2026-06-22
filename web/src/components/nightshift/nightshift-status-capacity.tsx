// Per-profile capacity burn-down for the Status screen (plan-nightshift.md §2.5).
// Reads the live `profileUsage` store slice (smart-balance telemetry, NEVER
// re-derived) -- a 5h/7d bar pair per profile, with the 75% interactive gate
// (the same `GATE_FIVE_HOUR_PCT` the watchdog enforces) marked on the 5h bar.
import type { ProfileUsageSnapshot } from '@shared/protocol'
import { cn } from '@/lib/utils'

// Mirrors the smart-balance hard gate (src/sentinel/selection.ts GATE_FIVE_HOUR_PCT).
const GATE_PCT = 75

type ProfileRow = ProfileUsageSnapshot & { sentinelId: string }

function usageTone(pct: number): string {
  if (pct >= 90) return 'bg-destructive'
  if (pct >= GATE_PCT) return 'bg-warning'
  return 'bg-active'
}

function Bar({ label, pct, gate }: { label: string; pct?: number; gate?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-4 shrink-0 text-[8px] uppercase text-muted-foreground/60">{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        {typeof pct === 'number' && (
          <div
            className={cn('h-full rounded-full', usageTone(pct))}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
        {gate && (
          <div
            className="absolute inset-y-0 w-px bg-foreground/40"
            style={{ left: `${GATE_PCT}%` }}
            title={`${GATE_PCT}% gate`}
          />
        )}
      </div>
      <span className="w-8 shrink-0 text-right text-[9px] tabular-nums text-muted-foreground">
        {typeof pct === 'number' ? `${Math.round(pct)}%` : '--'}
      </span>
    </div>
  )
}

function ProfileCard({ p }: { p: ProfileRow }) {
  const overGate = (p.fiveHour?.usedPercent ?? 0) >= GATE_PCT
  return (
    <div className="rounded border border-border/60 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[10px] font-medium">{p.profile}</span>
        {p.stale && <span className="text-[8px] text-muted-foreground/60">stale</span>}
        {overGate && <span className="ml-auto shrink-0 text-[8px] uppercase text-warning">over gate</span>}
        {p.error && <span className="ml-auto shrink-0 text-[9px] text-destructive">{p.error.kind}</span>}
      </div>
      {p.authed && !p.error ? (
        <div className="mt-1.5 space-y-1">
          <Bar label="5h" pct={p.fiveHour?.usedPercent} gate />
          <Bar label="7d" pct={p.sevenDay?.usedPercent} />
        </div>
      ) : (
        <p className="mt-1 text-[9px] text-muted-foreground/60">{p.authed ? 'no reading' : 'not authed'}</p>
      )}
    </div>
  )
}

export function NightshiftStatusCapacity({ profiles }: { profiles: ProfileRow[] }) {
  if (profiles.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No capacity telemetry yet.</p>
  }
  const sorted = [...profiles].sort((a, b) => a.profile.localeCompare(b.profile))
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {sorted.map(p => (
        <ProfileCard key={`${p.sentinelId}:${p.profile}`} p={p} />
      ))}
    </div>
  )
}
