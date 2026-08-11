/**
 * The WHEN half of the editor: Repeating (cron) or Once (a single moment).
 *
 * A one-time task is genuinely a different thing from a recurrence, not a cron
 * with a run cap -- forcing it through cron would describe "run once on 15 Aug"
 * as "every year on the 15th of August", which is a lie the UI would keep
 * telling until it fired.
 *
 * The datetime is entered as a WALL CLOCK in the chosen zone and resolved to an
 * instant on the way out, so a time that does not exist there (the DST
 * spring-forward gap) is refused here rather than silently never firing.
 */

import { formatWhen, viewerTimeZone } from '@shared/format-when'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { cn } from '@/lib/utils'
import { CronField } from './cron-field'
import { resolveRunAt } from './draft-time'
import type { ScheduleDraft, ScheduleMode } from './use-schedule-draft'

const MODES: Array<{ value: ScheduleMode; label: string; hint: string }> = [
  { value: 'repeating', label: 'Repeating', hint: 'Runs on a cron, over and over.' },
  { value: 'once', label: 'Once', hint: 'Runs a single time, then disarms itself.' },
]

const INPUT_CLASS =
  'bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50'

/** The resolved instant, echoed back in the reader's own clock with a countdown. */
function OncePreview({ runAt, tz }: { runAt: number | null; tz: string }) {
  const relative = useRelativeTime(runAt)
  if (runAt === null) {
    return (
      <div className="text-[10px] font-mono text-red-400">
        That wall-clock time does not exist in {tz} -- the clocks skip it.
      </div>
    )
  }
  const when = formatWhen(runAt, { scheduleTz: tz, viewerTz: viewerTimeZone() })
  return (
    <div className="space-y-0.5 text-[10px] font-mono text-muted-foreground">
      <div className="text-[9px] uppercase tracking-wide text-comment">Runs once</div>
      <div className="flex items-baseline justify-between gap-3 tabular-nums text-foreground">
        <span className="truncate">{when.absoluteDual}</span>
        <span className="shrink-0 text-primary">{relative}</span>
      </div>
    </div>
  )
}

export function WhenField({ draft, patch }: { draft: ScheduleDraft; patch: (next: Partial<ScheduleDraft>) => void }) {
  const viewer = viewerTimeZone()

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        {MODES.map(m => (
          <button
            key={m.value}
            type="button"
            onClick={() => patch({ mode: m.value })}
            className={cn(
              'flex-1 px-2 py-1 text-[11px] font-mono rounded border transition-colors',
              draft.mode === m.value
                ? 'bg-primary/15 text-primary border-primary/30'
                : 'text-comment border-border hover:text-foreground',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="text-[9px] text-comment pl-0.5">{MODES.find(m => m.value === draft.mode)?.hint}</div>

      {draft.mode === 'repeating' ? (
        <CronField
          cron={draft.cron}
          tz={draft.tz}
          onCronChange={cron => patch({ cron })}
          onTzChange={tz => patch({ tz })}
        />
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              aria-label="Run at"
              type="datetime-local"
              value={draft.runAtLocal}
              onChange={e => patch({ runAtLocal: e.target.value })}
              className={cn(INPUT_CLASS, 'flex-1')}
            />
            <select
              aria-label="Timezone"
              value={draft.tz}
              onChange={e => patch({ tz: e.target.value })}
              className={INPUT_CLASS}
            >
              {[...new Set([draft.tz, viewer, 'UTC'])].map(zone => (
                <option key={zone} value={zone}>
                  {zone}
                  {zone === viewer ? ' (yours)' : ''}
                </option>
              ))}
            </select>
          </div>
          <OncePreview runAt={resolveRunAt(draft.runAtLocal, draft.tz)} tz={draft.tz} />
        </div>
      )}
    </div>
  )
}
