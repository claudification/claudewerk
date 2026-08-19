import { CLOSEABLE_ICON, formatAgeShort, isStatusSuperseded, STATUS_META } from '@/lib/status-style'
import type { LiveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { StatusHoverCard } from './status-hover-card'

/**
 * THE STATUS — compact, glanceable form of the agent's self-reported
 * `set_status`, for dense lists (batch view, rosters). A single colored state
 * GLYPH + an optional "✕" closeable marker + the status age. Everything else
 * (the done/pending/blocked/... detail fields, both ages, the superseded note)
 * lives in the hover card (StatusHoverCard) — rendered as Markdown, not a raw
 * `title` string. "empty is signal", so only populated fields show.
 *
 * SUPERSEDED: if the user posted a message AFTER the status was set, the report
 * is stale (it predates what the user did next). We dim it and say so in the
 * hover card rather than hide it — a stale "done" is itself information. Keyed off
 * `lastInputAt` only (see isStatusSuperseded for why not lastActivity).
 */

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
  return (
    <StatusHoverCard status={status} lastInputAt={lastInputAt}>
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', superseded && 'opacity-40')}>
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
          <span className={cn('text-[9px] text-fg-muted', superseded && 'line-through')}>
            {formatAgeShort(status.updatedAt)}
          </span>
        )}
      </span>
    </StatusHoverCard>
  )
}
