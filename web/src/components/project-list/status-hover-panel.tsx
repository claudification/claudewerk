import { StatusDetailFields } from '@/components/status-handoff-body'
import { CLOSEABLE_ICON, formatAgeShort, STATUS_META } from '@/lib/status-style'
import type { LiveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * THE STATUS hover panel BODY — the floating card shown when hovering a status
 * badge/glyph in the conversation list or batch view. Pure + presentational (no
 * hover/portal/positioning, which live in StatusHoverCard) so it renders under
 * SSR and is unit-testable. Mirrors the transcript HANDOFF card: a state-colored
 * header (label · age, plus superseded / closeable / last-input lines) over the
 * Markdown-rendered detail fields. Replaces the old plain-text `title` tooltip,
 * so `code`, **bold**, and links render instead of raw markdown source.
 */
export function StatusHoverPanel({
  status,
  lastInputAt,
  superseded = false,
}: {
  status: LiveStatus
  lastInputAt?: number
  superseded?: boolean
}) {
  const meta = STATUS_META[status.state]
  return (
    // No outer border/rounded/shadow here — the floating wrapper (StatusHoverCard)
    // owns the chrome and clips corners. This supplies only the state tint + header.
    <div className={meta.bg}>
      <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-2', meta.border)}>
        <span className={cn('inline-flex items-center gap-1.5 text-xs font-bold tracking-wide', meta.text)}>
          <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <span className="text-[10px] tracking-wide text-fg-dim">{formatAgeShort(status.updatedAt)} ago</span>
        {status.safe_to_close && (
          <span className="text-[10px] font-bold text-muted-foreground">{`${CLOSEABLE_ICON} closeable`}</span>
        )}
        {superseded && (
          <span className="basis-full text-[10px] font-medium text-amber-400/90">
            {'⚠ superseded — you sent input after this was set'}
          </span>
        )}
        {lastInputAt != null && (
          <span className="basis-full text-[10px] text-fg-dim">last input · {formatAgeShort(lastInputAt)} ago</span>
        )}
      </div>
      <StatusDetailFields source={status} className="px-3 py-2.5" />
    </div>
  )
}
