import { CLOSEABLE_ICON, formatAgeShort, isStatusSuperseded, STATUS_FIELDS, STATUS_META } from '@/lib/status-style'
import type { LiveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * THE STATUS — compact, glanceable form of the agent's self-reported
 * `set_status`, for dense lists (batch view, rosters). A single colored state
 * GLYPH + an optional "✕" closeable marker + the status age. Everything else
 * (the done/pending/blocked/... detail fields, both ages, the superseded note)
 * lives in the hover tooltip — "empty is signal", so only populated fields show.
 *
 * SUPERSEDED: if the user posted a message AFTER the status was set, the report
 * is stale (it predates what the user did next). We dim it and say so in the
 * tooltip rather than hide it — a stale "done" is itself information. Keyed off
 * `lastInputAt` only (see isStatusSuperseded for why not lastActivity).
 */

/** Build the multi-line hover tooltip from the populated fields + ages. */
function buildTooltip(status: LiveStatus, lastInputAt: number | undefined, superseded: boolean): string {
  const meta = STATUS_META[status.state]
  const lines: string[] = [`${meta.label} · ${formatAgeShort(status.updatedAt)} ago`]
  if (superseded) lines.push('⚠ superseded — you sent input after this was set')
  for (const f of STATUS_FIELDS) {
    const v = status[f.key]
    if (typeof v === 'string' && v.trim()) lines.push(`${f.label}: ${v}`)
  }
  if (status.safe_to_close) lines.push('safe to close')
  if (lastInputAt != null) lines.push(`last input: ${formatAgeShort(lastInputAt)} ago`)
  return lines.join('\n')
}

export function StatusIcon({
  status,
  lastInputAt,
  showAge = true,
}: {
  status: LiveStatus | undefined
  lastInputAt?: number
  showAge?: boolean
}) {
  if (!status) return null
  const meta = STATUS_META[status.state]
  const superseded = isStatusSuperseded(status, lastInputAt)
  const tooltip = buildTooltip(status, lastInputAt, superseded)
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap', superseded && 'opacity-40')}
      title={tooltip}
    >
      <span
        className={cn(
          'font-bold leading-none',
          meta.text,
          status.state === 'needs_you' && !superseded && 'animate-pulse',
        )}
        role="img"
        aria-label={meta.label}
      >
        {meta.icon}
      </span>
      {status.safe_to_close && (
        <span className="text-muted-foreground leading-none" role="img" aria-label="safe to close">
          {CLOSEABLE_ICON}
        </span>
      )}
      {showAge && (
        <span className={cn('text-[9px] text-muted-foreground/70', superseded && 'line-through')}>
          {formatAgeShort(status.updatedAt)}
        </span>
      )}
    </span>
  )
}
