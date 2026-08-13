import { Popover } from 'radix-ui'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import type { ProfileUsageSnapshot, UsageWindow } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { LegacyBody, MultiProfileBody, type SentinelGroup } from './usage/usage-bodies'
import { usageBorderColor, usageColor, usageTextColor } from './usage/usage-colors'

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
    return Array.from(bySentinel.values()).toSorted((a, b) => a.alias.localeCompare(b.alias))
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
          {grouped.length > 0 ? <MultiProfileBody groups={grouped} /> : planUsage && <LegacyBody usage={planUsage} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
