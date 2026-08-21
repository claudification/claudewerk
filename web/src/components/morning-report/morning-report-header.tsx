/**
 * The line under the title bar: WHICH brew this is, and how old.
 *
 * Staleness is rendered whether it is stale or not, and the date is always
 * printed beside the label. "From Tuesday" is honest about a sweep that has not
 * run since; hiding it would leave a panel that looks identical on a working
 * morning and on a broken week.
 *
 * The census -- candidates considered vs proposals earned -- is the denominator.
 * "12 considered, 3 proposed" reads as a working sweep and "0 considered" reads
 * as a broken one; printing proposals alone makes those two look the same.
 */

import type { BoardReportRecord } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { staleness } from './morning-report-staleness'

export function MorningReportHeader({ report, nowMs }: { report: BoardReportRecord; nowMs: number }) {
  const age = staleness(report.date, report.tz, nowMs)

  return (
    <div className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs font-medium">{report.date}</span>
        <span className={cn('text-[10px]', age.stale ? 'text-amber-500' : 'text-muted-foreground')}>
          {age.label}
          {age.stale && ' -- no sweep has landed since'}
        </span>
        <span className="text-[10px] text-muted-foreground">({report.tz})</span>
      </div>
      <div className="text-[10px] leading-relaxed text-muted-foreground">
        {report.selected} candidate card(s) considered, {report.acted} earned a proposal, {report.refused} refused.{' '}
        <code className="font-mono">{report.reportPath}</code>
      </div>
    </div>
  )
}
