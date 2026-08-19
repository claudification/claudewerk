/** One profile's usage block inside the multi-profile popover: the tinted
 *  profile chip, the worst-window headline, then the 5h / 7d / extra bars.
 *
 *  The chip is the SAME `ProfileChip` the conversation list renders, so `[A]`
 *  in the sidebar and `[A]` here are recognisably the same profile. Unlike the
 *  conversation list this surface IGNORES `showLabel: false` -- telling the
 *  rows apart is the entire job of this panel, so an operator who hides the
 *  ambient profile's badge on every conversation row still gets it here. */

import { ProfileChip } from '@/components/profile-chip'
import { useConversationsStore } from '@/hooks/use-conversations'
import { findProfileMeta } from '@/lib/profile-display'
import type { ProfileUsageSnapshot } from '@/lib/types'
import { formatAge } from '@/lib/utils'
import { usageTextColor } from './usage-colors'
import { DetailBar, ExtraUsageRow } from './usage-rows'

/** Chip for a usage row, resolved from the live sentinel report. Renders
 *  nothing when the profile carries no label (nothing to put in the box). */
function UsageProfileChip({ alias, profile }: { alias: string; profile: string }) {
  const sentinels = useConversationsStore(s => s.sentinels)
  const meta = findProfileMeta(sentinels, alias, profile)
  if (!meta?.label) return null
  return <ProfileChip label={meta.label} color={meta.color} title={`Profile: ${profile} - ${meta.label}`} />
}

function ProfileHeading({ alias, profile }: { alias: string; profile: string }) {
  return (
    <>
      <UsageProfileChip alias={alias} profile={profile} />
      <span className="text-[10px] text-foreground/80 w-16 truncate">{profile}</span>
    </>
  )
}

// fallow-ignore-next-line complexity
export function ProfileRow({ snap, alias }: { snap: ProfileUsageSnapshot; alias: string }) {
  const fiveHour = snap.fiveHour
  const sevenDay = snap.sevenDay
  if (snap.error || !fiveHour || !sevenDay) {
    const label = snap.error ? `${snap.error.kind === 'no_token' ? 'not authed' : snap.error.kind}` : 'no data'
    return (
      <div className="flex items-center gap-2 text-[10px] text-fg-dim">
        <ProfileHeading alias={alias} profile={snap.profile} />
        <span className="italic">{label}</span>
      </div>
    )
  }
  const pct = Math.max(fiveHour.usedPercent, sevenDay.usedPercent)
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <ProfileHeading alias={alias} profile={snap.profile} />
        <span className={`text-[10px] tabular-nums ${usageTextColor(pct)}`}>worst {Math.round(pct)}%</span>
        {snap.stale && (
          <span
            className="text-[9px] text-amber-400/80 italic"
            title="Live usage poll is rate-limited (429); showing the last known reading"
          >
            {formatAge(snap.polledAt)}
          </span>
        )}
      </div>
      <DetailBar window={fiveHour} label="5h" />
      <DetailBar window={sevenDay} label="7d" />
      {snap.extraUsage?.isEnabled && <ExtraUsageRow extra={snap.extraUsage} />}
    </div>
  )
}
