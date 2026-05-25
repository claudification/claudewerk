import { Popover } from 'radix-ui'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import type { ExtraUsage, ProfileUsageSnapshot, UsageWindow } from '@/lib/types'
import { haptic } from '@/lib/utils'

function usageColor(pct: number): string {
  if (pct < 50) return 'bg-emerald-500'
  if (pct < 75) return 'bg-amber-500'
  if (pct < 90) return 'bg-orange-500'
  return 'bg-red-500'
}

function usageTextColor(pct: number): string {
  if (pct < 50) return 'text-emerald-400'
  if (pct < 75) return 'text-amber-400'
  if (pct < 90) return 'text-orange-400'
  return 'text-red-400'
}

function usageBorderColor(pct: number): string {
  if (pct < 50) return 'border-emerald-500/30'
  if (pct < 75) return 'border-amber-500/30'
  if (pct < 90) return 'border-orange-500/30'
  return 'border-red-500/30'
}

// fallow-ignore-next-line complexity
function formatReset(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

function formatResetAbsolute(resetAt: string): string {
  const dt = new Date(resetAt)
  const day = dt.toLocaleDateString(undefined, { weekday: 'short' })
  const time = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} ${time}`
}

function DetailBar({ window: w, label }: { window: UsageWindow; label: string }) {
  const pct = Math.min(w.usedPercent, 100)
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-20">
        <div
          className={`h-full ${usageColor(pct)} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums font-medium w-8 ${usageTextColor(pct)}`}>{Math.round(pct)}%</span>
      <span className="text-[10px] text-muted-foreground/50 w-12 tabular-nums" title={formatResetAbsolute(w.resetAt)}>
        {formatReset(w.resetAt)}
      </span>
    </div>
  )
}

function getMonthlyResetDate(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1)
}

function ExtraUsageRow({ extra }: { extra: ExtraUsage }) {
  if (!extra.isEnabled) return null
  const pct = extra.utilization != null ? Math.min(extra.utilization * 100, 100) : 0
  const used = extra.usedCredits.toFixed(2)
  const limit = extra.monthlyLimit.toFixed(2)
  const resetDate = getMonthlyResetDate()
  const resetIso = resetDate.toISOString()
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">extra</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-20">
        <div
          className={`h-full ${usageColor(pct)} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums font-medium ${usageTextColor(pct)}`}>
        ${used}/${limit}
      </span>
      <span className="text-[10px] text-muted-foreground/50 w-12 tabular-nums" title={formatResetAbsolute(resetIso)}>
        {formatReset(resetIso)}
      </span>
    </div>
  )
}

/** A single profile row inside the multi-profile popover. */
// fallow-ignore-next-line complexity
function ProfileRow({ snap }: { snap: ProfileUsageSnapshot }) {
  const fiveHour = snap.fiveHour
  const sevenDay = snap.sevenDay
  if (snap.error || !fiveHour || !sevenDay) {
    const label = snap.error ? `${snap.error.kind === 'no_token' ? 'not authed' : snap.error.kind}` : 'no data'
    return (
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
        <span className="w-16 truncate">{snap.profile}</span>
        <span className="italic">{label}</span>
      </div>
    )
  }
  const pct = Math.max(fiveHour.usedPercent, sevenDay.usedPercent)
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] text-foreground/80 w-16 truncate">{snap.profile}</span>
        <span className={`text-[10px] tabular-nums ${usageTextColor(pct)}`}>worst {Math.round(pct)}%</span>
      </div>
      <DetailBar window={fiveHour} label="5h" />
      <DetailBar window={sevenDay} label="7d" />
    </div>
  )
}

/** Returns the per-profile snapshot with the highest "worst-window" usage,
 *  i.e. the most-stressed profile. The summary chip shows this one so
 *  glance-value flags trouble before the popover is opened. Returns
 *  `undefined` when no profile has both windows available. */
// fallow-ignore-next-line complexity
function pickMostStressed(
  snaps: ProfileUsageSnapshot[],
): { profile: string; pct: number; fiveHour: UsageWindow; sevenDay: UsageWindow } | undefined {
  let worst: { profile: string; pct: number; fiveHour: UsageWindow; sevenDay: UsageWindow } | undefined
  for (const s of snaps) {
    if (!s.fiveHour || !s.sevenDay) continue
    const pct = Math.max(s.fiveHour.usedPercent, s.sevenDay.usedPercent)
    if (!worst || pct > worst.pct) worst = { profile: s.profile, pct, fiveHour: s.fiveHour, sevenDay: s.sevenDay }
  }
  return worst
}

interface SentinelGroup {
  sentinelId: string
  alias: string
  snaps: Array<ProfileUsageSnapshot & { polledAt: number }>
}

function MultiProfileBody({ groups, extra }: { groups: SentinelGroup[]; extra?: ExtraUsage }) {
  return (
    <div className="space-y-3">
      {groups.map(group => (
        <div key={group.sentinelId} className="space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">{group.alias}</div>
            <div className="text-[9px] text-muted-foreground/40 tabular-nums">
              {group.snaps[0]?.polledAt ? `polled ${new Date(group.snaps[0].polledAt).toLocaleTimeString()}` : ''}
            </div>
          </div>
          {group.snaps.map(snap => (
            <ProfileRow key={`${group.sentinelId}/${snap.profile}`} snap={snap} />
          ))}
        </div>
      ))}
      {extra?.isEnabled && (
        <>
          <div className="border-t border-border/50 my-1" />
          <ExtraUsageRow extra={extra} />
        </>
      )}
    </div>
  )
}

// fallow-ignore-next-line complexity
function LegacyBody({ usage }: { usage: NonNullable<ReturnType<typeof useConversationsStore.getState>['planUsage']> }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Plan Usage</div>
      <DetailBar window={usage.fiveHour} label="5h" />
      <DetailBar window={usage.sevenDay} label="7d" />
      {(usage.sevenDayOpus || usage.sevenDaySonnet) && (
        <>
          <div className="border-t border-border/50 my-2" />
          <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">Per Model</div>
          {usage.sevenDayOpus && <DetailBar window={usage.sevenDayOpus} label="opus" />}
          {usage.sevenDaySonnet && <DetailBar window={usage.sevenDaySonnet} label="sonnet" />}
        </>
      )}
      {usage.extraUsage?.isEnabled && (
        <>
          <div className="border-t border-border/50 my-2" />
          <ExtraUsageRow extra={usage.extraUsage} />
        </>
      )}
      <div className="border-t border-border/50 mt-2 pt-1">
        <span className="text-[9px] text-muted-foreground/40">
          Polled {new Date(usage.polledAt).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
}

// fallow-ignore-next-line complexity
export function UsageBar() {
  const planUsage = useConversationsStore(s => s.planUsage)
  const profileUsage = useConversationsStore(s => s.profileUsage)
  const sentinels = useConversationsStore(s => s.sentinels)
  const { open, setOpen, handleMouseEnter, handleMouseLeave, cancelClose, toggle } = useHoverPopover()

  // Group snapshots by sentinel for the popover. Resolve alias for display.
  // fallow-ignore-next-line complexity
  const grouped = useMemo<SentinelGroup[]>(() => {
    const aliasFor = new Map<string, string>()
    for (const s of sentinels) aliasFor.set(s.sentinelId, s.alias)
    const bySentinel = new Map<string, SentinelGroup>()
    for (const entry of Object.values(profileUsage)) {
      let bucket = bySentinel.get(entry.sentinelId)
      if (!bucket) {
        bucket = { sentinelId: entry.sentinelId, alias: aliasFor.get(entry.sentinelId) ?? entry.sentinelId, snaps: [] }
        bySentinel.set(entry.sentinelId, bucket)
      }
      bucket.snaps.push(entry)
    }
    for (const bucket of bySentinel.values()) bucket.snaps.sort((a, b) => a.profile.localeCompare(b.profile))
    return [...bySentinel.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }, [profileUsage, sentinels])

  // Pick the summary chip's source: most-stressed across ALL profiles for
  // multi-profile installs, falling back to legacy planUsage when no
  // sentinel_usage_report has landed yet (single-profile, pre-Phase-1
  // sentinel, or just-reconnected panel before first poll cycle).
  const allSnaps = grouped.flatMap(g => g.snaps)
  const stressed = pickMostStressed(allSnaps)
  if (!stressed && !planUsage) return null

  const summaryPct = stressed ? stressed.pct : Math.min(planUsage?.sevenDay.usedPercent ?? 0, 100)
  const tooltip = stressed
    ? `${grouped.length > 1 ? `${stressed.profile} (worst across ${allSnaps.length} profiles)` : stressed.profile}: ${Math.round(stressed.pct)}%`
    : 'plan usage'
  const pct = Math.min(summaryPct, 100)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={tooltip}
          className="flex items-center gap-1 cursor-pointer select-none hover:opacity-80 transition-opacity"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={() => {
            haptic('tap')
            toggle()
          }}
        >
          <span className={`text-[10px] ${usageTextColor(pct)} opacity-70`}>{stressed ? 'max' : '7d'}</span>
          <div className="w-10 sm:w-14 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full ${usageColor(pct)} rounded-full transition-all duration-500`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={`text-[10px] tabular-nums ${usageTextColor(pct)}`}>{Math.round(pct)}%</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className={`z-50 w-80 rounded border ${usageBorderColor(pct)} bg-background/95 backdrop-blur-sm shadow-lg p-3 font-mono`}
          sideOffset={8}
          align="start"
          onMouseEnter={cancelClose}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          {grouped.length > 0 ? (
            <MultiProfileBody groups={grouped} extra={planUsage?.extraUsage} />
          ) : (
            planUsage && <LegacyBody usage={planUsage} />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
