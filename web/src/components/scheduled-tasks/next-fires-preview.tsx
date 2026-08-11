/**
 * "When will this actually run?" -- rendered under the cron field.
 *
 * Three things, always together, because a bare "09:00" is ambiguous when the
 * broker runs in UTC and the reader does not: the schedule's own clock, the same
 * instant in the READER's clock, and how long until it happens. The relative line
 * ticks live off one shared app timer (`useRelativeTime`).
 */

import { nextFires } from '@shared/cron-next'
import { parseCron } from '@shared/cron-parse'
import { formatWhen, viewerTimeZone } from '@shared/format-when'
import { useMemo } from 'react'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { cn } from '@/lib/utils'

/** One upcoming fire: absolute (disambiguated) + a live countdown. */
function FireRow({ ms, tz, emphasise }: { ms: number; tz: string; emphasise?: boolean }) {
  const relative = useRelativeTime(ms)
  const when = useMemo(() => formatWhen(ms, { scheduleTz: tz, viewerTz: viewerTimeZone() }), [ms, tz])
  return (
    <div className={cn('flex items-baseline justify-between gap-3 tabular-nums', emphasise && 'text-foreground')}>
      <span className="truncate">{when.absoluteDual}</span>
      <span className={cn('shrink-0', emphasise ? 'text-primary' : 'text-comment')}>{relative}</span>
    </div>
  )
}

export function NextFiresPreview({ cron, tz, count = 5 }: { cron: string; tz: string; count?: number }) {
  const fires = useMemo(() => {
    const parsed = parseCron(cron)
    if (!parsed.ok) return []
    return nextFires(parsed.fields, tz, Date.now(), count)
  }, [cron, tz, count])

  if (fires.length === 0) {
    return (
      <div className="text-[10px] font-mono text-comment">
        No upcoming runs -- check the expression, or it may not recur within the next four years.
      </div>
    )
  }

  return (
    <div className="space-y-0.5 text-[10px] font-mono text-muted-foreground">
      <div className="text-[9px] uppercase tracking-wide text-comment">Next runs</div>
      {fires.map((ms, i) => (
        <FireRow key={ms} ms={ms} tz={tz} emphasise={i === 0} />
      ))}
    </div>
  )
}

/**
 * The single-line variant for lists and tooltips: "Wed 13 Aug, 09:00 -- in 2 minutes".
 * `null` renders the reason it will never fire rather than an invented time.
 */
export function NextFireLine({ ms, tz, never }: { ms: number | null; tz: string; never?: string }) {
  const relative = useRelativeTime(ms)
  if (ms === null) return <span className="text-comment">{never ?? 'not scheduled'}</span>
  const when = formatWhen(ms, { scheduleTz: tz, viewerTz: viewerTimeZone() })
  return (
    <span className="tabular-nums">
      {when.absoluteDual} <span className="text-primary">-- {relative}</span>
    </span>
  )
}
