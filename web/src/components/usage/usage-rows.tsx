/** The two bar rows inside the usage popover: a rolling window (5h / 7d) and
 *  the monthly extra-credits line. */

import type { ExtraUsage, UsageWindow } from '@/lib/types'
import { usageColor, usageTextColor } from './usage-colors'
import { formatReset, formatResetAbsolute, getMonthlyResetDate } from './usage-format'

export function DetailBar({ window: w, label }: { window: UsageWindow; label: string }) {
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
      <span className="text-[10px] text-fg-dim w-12 tabular-nums" title={formatResetAbsolute(w.resetAt)}>
        {formatReset(w.resetAt)}
      </span>
    </div>
  )
}

export function ExtraUsageRow({ extra }: { extra: ExtraUsage }) {
  if (!extra.isEnabled) return null
  const pct = extra.utilization != null ? Math.min(extra.utilization * 100, 100) : 0
  const used = extra.usedCredits.toFixed(2)
  const limit = extra.monthlyLimit.toFixed(2)
  const resetIso = getMonthlyResetDate().toISOString()
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
      <span className="text-[10px] text-fg-dim w-12 tabular-nums" title={formatResetAbsolute(resetIso)}>
        {formatReset(resetIso)}
      </span>
    </div>
  )
}
