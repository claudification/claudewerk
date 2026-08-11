/**
 * The WHEN half of the schedule editor: a cron expression, the zone it is read
 * in, and a live preview of what that actually means.
 *
 * The expression is validated as you type (`describeCron` renders either an
 * English sentence or the parse error), so a typo is caught before saving rather
 * than discovered a week later when the schedule turns out never to have fired.
 * The zone is a first-class field, never implicit -- see `format-when.ts`.
 */

import { describeCron } from '@shared/cron-describe'
import { parseCron } from '@shared/cron-parse'
import { viewerTimeZone } from '@shared/format-when'
import { cn } from '@/lib/utils'
import { NextFiresPreview } from './next-fires-preview'

/** Common shapes, so the usual cases need no cron knowledge at all. */
const PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays 09:00', cron: '0 9 * * 1' },
]

/**
 * A short list of zones plus whatever the viewer is in, so the common case is one
 * click and the exotic case is still reachable by typing. Not the full IANA list:
 * 400+ options in a dropdown helps nobody.
 */
function zoneOptions(current: string): string[] {
  const viewer = viewerTimeZone()
  const common = [
    viewer,
    'UTC',
    'Europe/Berlin',
    'Europe/London',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Tokyo',
  ]
  return [...new Set([current, ...common].filter(Boolean))]
}

export function CronField({
  cron,
  tz,
  onCronChange,
  onTzChange,
}: {
  cron: string
  tz: string
  onCronChange: (cron: string) => void
  onTzChange: (tz: string) => void
}) {
  const parsed = parseCron(cron)
  const description = describeCron(cron)
  const viewer = viewerTimeZone()

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">Schedule</div>

      <div className="flex gap-1.5 flex-wrap">
        {PRESETS.map(p => (
          <button
            key={p.cron}
            type="button"
            onClick={() => onCronChange(p.cron)}
            className={cn(
              'px-2 py-0.5 text-[10px] font-mono rounded border transition-colors',
              cron === p.cron
                ? 'bg-primary/15 text-primary border-primary/30'
                : 'text-comment border-border hover:text-foreground',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          aria-label="Cron expression"
          type="text"
          value={cron}
          onChange={e => onCronChange(e.target.value)}
          placeholder="0 9 * * 1-5"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className={cn(
            'flex-1 bg-surface-inset border rounded px-2 py-1.5 text-[11px] font-mono text-foreground',
            'focus:outline-none focus:ring-1',
            parsed.ok ? 'border-border focus:ring-primary/50' : 'border-red-500/50 focus:ring-red-500/50',
          )}
        />
        <select
          aria-label="Timezone"
          value={tz}
          onChange={e => onTzChange(e.target.value)}
          className="bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          {zoneOptions(tz).map(zone => (
            <option key={zone} value={zone}>
              {zone}
              {zone === viewer ? ' (yours)' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className={cn('text-[10px] font-mono pl-0.5', parsed.ok ? 'text-primary/80' : 'text-red-400')}>
        {description}
      </div>

      {parsed.ok && <NextFiresPreview cron={cron} tz={tz} />}
    </div>
  )
}
