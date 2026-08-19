/** The two popover bodies: one group per sentinel with a row per profile
 *  (multi-profile installs), and the legacy single-plan body for sentinels
 *  that have not reported a `sentinel_usage_report` yet. */

import type { ProfileUsageSnapshot, UsageUpdate } from '@/lib/types'
import { ProfileRow } from './profile-row'
import { DetailBar, ExtraUsageRow } from './usage-rows'

export interface SentinelGroup {
  sentinelId: string
  alias: string
  snaps: Array<ProfileUsageSnapshot & { polledAt: number }>
}

export function MultiProfileBody({ groups }: { groups: SentinelGroup[] }) {
  return (
    <div className="space-y-3">
      {groups.map(group => (
        <div key={group.sentinelId} className="space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="text-[10px] text-fg-dim uppercase tracking-wider">{group.alias}</div>
            <div className="text-[9px] text-fg-faint tabular-nums">
              {group.snaps[0]?.polledAt ? `polled ${new Date(group.snaps[0].polledAt).toLocaleTimeString()}` : ''}
            </div>
          </div>
          {group.snaps.map(snap => (
            <ProfileRow key={`${group.sentinelId}/${snap.profile}`} snap={snap} alias={group.alias} />
          ))}
        </div>
      ))}
    </div>
  )
}

// fallow-ignore-next-line complexity
export function LegacyBody({ usage }: { usage: UsageUpdate }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-fg-dim uppercase tracking-wider mb-2">Plan Usage</div>
      <DetailBar window={usage.fiveHour} label="5h" />
      <DetailBar window={usage.sevenDay} label="7d" />
      {(usage.sevenDayOpus || usage.sevenDaySonnet) && (
        <>
          <div className="border-t border-border my-2" />
          <div className="text-[10px] text-fg-dim uppercase tracking-wider mb-1">Per Model</div>
          {usage.sevenDayOpus && <DetailBar window={usage.sevenDayOpus} label="opus" />}
          {usage.sevenDaySonnet && <DetailBar window={usage.sevenDaySonnet} label="sonnet" />}
        </>
      )}
      {usage.extraUsage?.isEnabled && (
        <>
          <div className="border-t border-border my-2" />
          <ExtraUsageRow extra={usage.extraUsage} />
        </>
      )}
      <div className="border-t border-border mt-2 pt-1">
        <span className="text-[9px] text-fg-faint">
          Polled {new Date(usage.polledAt).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
}
